// Ambient globals for the build-free scripts checked by tsconfig.scripts.json.
//
// sidepanel/panel-logic.js publishes TldrPanelLogic as a top-level const for
// the plain <script> tags in sidepanel/panel.html, but its trailing
// `module.exports` guard makes TypeScript treat the file as a CommonJS module,
// so the const never reaches the checker's global scope. Declared loosely on
// purpose: the source of truth is panel-logic.js, and a hand-maintained shape
// here could drift without the compiler noticing.
declare const TldrPanelLogic: Record<string, (...args: any[]) => any>;
