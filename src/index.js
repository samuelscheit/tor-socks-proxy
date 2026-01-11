"use strict";

const { TorManager } = require("./torManager");
const { createHttpProxyServer } = require("./proxy");

const HTTP_PROXY_PORT = parseInt(process.env.HTTP_PROXY_PORT || "3128", 10);
const DEFAULT_TOR_SOCKS_PORT = parseInt(process.env.DEFAULT_TOR_SOCKS_PORT || "9150", 10);
const DEFAULT_TOR_CONFIG_PATH = process.env.DEFAULT_TOR_CONFIG_PATH || "/etc/tor/torrc";
const TOR_BIN = process.env.TOR_BIN || "/usr/bin/tor";

(async () => {
	const torManager = new TorManager({
		torBin: TOR_BIN,
		defaultTor: {
			socksPort: DEFAULT_TOR_SOCKS_PORT,
			configPath: DEFAULT_TOR_CONFIG_PATH,
		},
	});

	// Start the default Tor instance immediately (preserves existing behavior: SOCKS on 9150, DNS on 8853).
	await torManager.ensureDefault();

	const server = createHttpProxyServer({ torManager });

	server.listen(HTTP_PROXY_PORT, "0.0.0.0", () => {
		// eslint-disable-next-line no-console
		console.log(`HTTP proxy listening on :${HTTP_PROXY_PORT}`);
	});

	const shutdown = async (signal) => {
		// eslint-disable-next-line no-console
		console.log(`Received ${signal}, shutting down...`);
		server.close();
		await torManager.shutdown();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
})().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err);
	process.exit(1);
});
