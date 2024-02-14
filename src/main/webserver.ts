const http = require("http");

export function createServer(portnumber: number) {
  // Create a simple HTTP server
  const server = http.createServer((req, res) => {
    // Respond to all GET requests with a simple message
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Hello from Electron's Main Process!");
    }
  });

  server.listen(portnumber, () => {
    console.log(`Server listening on port ${portnumber}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`Port ${portnumber} is already in use.`);
      // Here you could attempt to find and kill the process using the port
    }
    console.error(`Server Error: ${error}`);
    console.error(error);
  });

  return server;
}
