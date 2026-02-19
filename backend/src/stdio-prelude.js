// STDIO MCP prelude — redirect console.log to stderr
// so only MCP JSON-RPC messages flow on stdout.
// Loaded via --require before tsx/cjs and the main module.
const _origLog = console.log.bind(console);
console.log = (...args) => console.error(...args);
