import http from "http";
import url from "url";
import soundConfig from "../shared/sounds.json";
import { SoundConfig } from "../shared/types";
import { getWindowContents } from "./renderer-window";

const sounds = (soundConfig as SoundConfig).sounds;

export function createServer(portnumber: number) {
	const server = http.createServer(
		(req: http.IncomingMessage, res: http.ServerResponse) => {
			if (req.method === "GET") {
				const parsedUrl = url.parse(req.url!, true);
				const queryParams = parsedUrl.query;
				const queryParamsDict: { [key: string]: string } = {};
				for (const key in queryParams) {
					if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
						queryParamsDict[key] = queryParams[key] as string;
					}
				}

				if (parsedUrl.href == "/favicon.ico") {
					res.writeHead(404);
					res.end("");
					return;
				}

				if (queryParamsDict.say) {
					getWindowContents().send("say-words", queryParamsDict.say);
				}

				// Map endpoints to sound IDs
				const endpointToSound = Object.entries(sounds).reduce(
					(acc, [_, sound]) => {
						sound.endpoints.forEach((endpoint) => {
							acc[endpoint] = sound.id;
						});
						return acc;
					},
					{} as { [key: string]: string },
				);

				const soundId = endpointToSound[parsedUrl.pathname!];
				if (soundId) {
					getWindowContents().send("play-sound", soundId);
				}

				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("Hello from Electron's Main Process!");
			}
		},
	);

	server.listen(portnumber, () => {
		console.log(`Server listening on port ${portnumber}`);
	});

	server.on("error", (error) => {
		if (error.code === "EADDRINUSE") {
			console.log(`Port ${portnumber} is already in use.`);
		}
		console.error(`Server Error: ${error}`);
	});

	return server;
}
