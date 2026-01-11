"use strict";

const http = require("node:http");
const https = require("node:https");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { SocksClient } = require("socks");

const EXIT_PARAM = process.env.TOR_EXIT_PARAM || "tor_exit";
const CONNECT_EXIT_HEADER = (process.env.TOR_CONNECT_EXIT_HEADER || "x-tor-exit-country").toLowerCase();

function getBasicAuthUsername(req) {
	const header = req.headers["proxy-authorization"];
	if (!header) return null;
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return null;

	const [scheme, encoded] = String(value).split(/\s+/, 2);
	if (!scheme || scheme.toLowerCase() !== "basic") return null;
	if (!encoded) return null;

	let decoded;
	try {
		decoded = Buffer.from(encoded, "base64").toString("utf8");
	} catch {
		return null;
	}

	const idx = decoded.indexOf(":");
	const username = (idx >= 0 ? decoded.slice(0, idx) : decoded).trim();
	return username || null;
}

function stripExitParam(urlObj) {
	const cc = urlObj.searchParams.get(EXIT_PARAM);
	urlObj.searchParams.delete(EXIT_PARAM);
	// If we removed the last query param, URL will keep trailing '?', so normalize.
	return { countryCode: cc, strippedUrl: urlObj.toString() };
}

function getCountryFromConnectHeaders(req) {
	const v = req.headers[CONNECT_EXIT_HEADER];
	if (!v) return null;
	if (Array.isArray(v)) return v[0];
	return v;
}

function createHttpProxyServer({ torManager }) {
	const server = http.createServer(async (clientReq, clientRes) => {
		try {
			if (clientReq.method === "GET" && clientReq.url === "/__health") {
				clientRes.writeHead(200, { "content-type": "text/plain" });
				clientRes.end("ok");
				return;
			}

			// In an HTTP proxy, clientReq.url is expected to be an absolute URL.
			const urlObj = new URL(clientReq.url);
			const { countryCode: countryFromQuery, strippedUrl } = stripExitParam(urlObj);
			const countryFromAuth = getBasicAuthUsername(clientReq);
			const countryCode = countryFromQuery || countryFromAuth;

			const socksPort = await torManager.getSocksPortForRequest({ countryCode });
			const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);

			const isHttps = urlObj.protocol === "https:";
			const upstream = isHttps ? https : http;

			const headers = { ...clientReq.headers };
			// Proxy-specific headers should not be forwarded as-is.
			delete headers["proxy-connection"];
			delete headers["proxy-authorization"];

			const upstreamReq = upstream.request(
				strippedUrl,
				{
					method: clientReq.method,
					headers,
					agent,
				},
				(upstreamRes) => {
					clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
					upstreamRes.pipe(clientRes);
				}
			);

			upstreamReq.on("error", (e) => {
				clientRes.writeHead(502, { "content-type": "text/plain" });
				clientRes.end(`Upstream error: ${e.message}`);
			});

			clientReq.pipe(upstreamReq);
		} catch (e) {
			clientRes.writeHead(400, { "content-type": "text/plain" });
			clientRes.end(`Bad request: ${e.message}`);
		}
	});

	// HTTPS tunneling support via CONNECT.
	// NOTE: CONNECT has no URL query string to carry parameters, so we accept an optional header:
	//   X-Tor-Exit-Country: us
	server.on("connect", async (req, clientSocket, head) => {
		const target = String(req.url);
		let host;
		let portStr;

		// CONNECT targets are typically "host:port" or "[ipv6]:port".
		if (target.startsWith("[")) {
			const end = target.indexOf("]");
			host = target.slice(1, end);
			portStr = target.slice(end + 2);
		} else {
			[host, portStr] = target.split(":");
		}

		const port = parseInt(portStr || "443", 10);

		try {
			const countryCode = getBasicAuthUsername(req) || getCountryFromConnectHeaders(req);
			const socksPort = await torManager.getSocksPortForRequest({ countryCode });

			const { socket: torSocket } = await SocksClient.createConnection({
				proxy: {
					host: "127.0.0.1",
					port: socksPort,
					type: 5,
				},
				command: "connect",
				destination: {
					host,
					port,
				},
			});

			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

			if (head && head.length) torSocket.write(head);

			clientSocket.pipe(torSocket);
			torSocket.pipe(clientSocket);

			const onError = () => {
				try {
					clientSocket.destroy();
				} catch {}
				try {
					torSocket.destroy();
				} catch {}
			};

			clientSocket.on("error", onError);
			torSocket.on("error", onError);
		} catch (e) {
			try {
				clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			} catch {
				// ignore
			}
			try {
				clientSocket.destroy();
			} catch {}
		}
	});

	return server;
}

module.exports = {
	createHttpProxyServer,
};
