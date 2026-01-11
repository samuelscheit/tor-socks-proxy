"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function normalizeCountryCode(value) {
	if (!value) return null;
	const code = String(value).trim().toLowerCase();
	if (!code) return null;
	if (code === "default" || code === "any") return null;
	if (!/^[a-z]{2}$/.test(code)) return null;
	return code;
}

function waitForTorBootstrap(proc, { timeoutMs }) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Tor bootstrap timed out after ${timeoutMs}ms`));
			try {
				proc.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, timeoutMs);

		const onData = (buf) => {
			const text = buf.toString("utf8");
			if (text.includes("Bootstrapped 100%")) {
				clearTimeout(timeout);
				resolve();
			}
		};

		const onExit = (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`Tor exited before bootstrap (code=${code}, signal=${signal})`));
		};

		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.once("exit", onExit);
	});
}

class TorManager {
	constructor({ torBin, defaultTor }) {
		this.torBin = torBin;
		this.defaultTor = defaultTor;

		this.defaultProcess = null;

		// countryCode -> { socksPort, process }
		this.countryInstances = new Map();
		// countryCode -> Promise<instance>
		this.creating = new Map();

		this.nextDynamicPort = parseInt(process.env.DYNAMIC_TOR_SOCKS_PORT_START || "9152", 10);
		this.baseDataDir = process.env.TOR_INSTANCES_DIR || "/var/lib/tor-instances";
	}

	async ensureDefault() {
		if (this.defaultProcess) return;

		// If the container already exposes SOCKS/DNS via torrc, we keep that behavior by spawning tor with torrc.
		this.defaultProcess = spawn(this.torBin, ["-f", this.defaultTor.configPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		this.defaultProcess.stdout.on("data", (d) => process.stdout.write(d));
		this.defaultProcess.stderr.on("data", (d) => process.stderr.write(d));

		await waitForTorBootstrap(this.defaultProcess, { timeoutMs: 120_000 });
	}

	async getSocksPortForRequest({ countryCode }) {
		const normalized = normalizeCountryCode(countryCode);
		if (!normalized) return this.defaultTor.socksPort;

		const existing = this.countryInstances.get(normalized);
		if (existing) return existing.socksPort;

		if (this.creating.has(normalized)) {
			const inst = await this.creating.get(normalized);
			return inst.socksPort;
		}

		const createPromise = this._createCountryInstance(normalized);
		this.creating.set(normalized, createPromise);

		try {
			const inst = await createPromise;
			this.countryInstances.set(normalized, inst);
			return inst.socksPort;
		} finally {
			this.creating.delete(normalized);
		}
	}

	async _createCountryInstance(countryCode) {
		const socksPort = this._allocatePort();
		const dataDir = path.join(this.baseDataDir, `tor-${countryCode}`);

		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

		// Tor config for a dedicated per-country instance.
		// NOTE: We keep it simple: SOCKS only, loopback-bound, strict exit selection.
		const torArgs = [
			"--Log",
			"notice stdout",
			"--SocksPort",
			`127.0.0.1:${socksPort}`,
			"--DataDirectory",
			dataDir,
			"--ExitNodes",
			`{${countryCode}}`,
			"--StrictNodes",
			"1",
			"--AvoidDiskWrites",
			"1",
		];

		const proc = spawn(this.torBin, torArgs, { stdio: ["ignore", "pipe", "pipe"] });

		proc.stdout.on("data", (d) => process.stdout.write(d));
		proc.stderr.on("data", (d) => process.stderr.write(d));

		await waitForTorBootstrap(proc, { timeoutMs: 180_000 });

		return { socksPort, process: proc };
	}

	_allocatePort() {
		const port = this.nextDynamicPort;
		this.nextDynamicPort += 1;
		return port;
	}

	async shutdown() {
		const kill = (p) => {
			if (!p) return;
			try {
				p.kill("SIGTERM");
			} catch {
				// ignore
			}
		};

		for (const inst of this.countryInstances.values()) kill(inst.process);
		kill(this.defaultProcess);
	}
}

module.exports = {
	TorManager,
	normalizeCountryCode,
};
