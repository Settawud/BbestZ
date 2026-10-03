// Registers the "API Log" panel next to Elements / Console / Network.
// Firefox exposes the same APIs under `browser`, Chrome under `chrome`.
const api = globalThis.browser ?? globalThis.chrome;

api.devtools.panels.create('API Log', '/icons/icon48.png', '/devtools/panel.html');
