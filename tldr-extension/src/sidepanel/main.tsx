import { createRoot } from "react-dom/client";
import { App } from "@/app";
import {
  PanelErrorBoundary,
  PanelFailure,
} from "@/components/panel/error-boundary";
import { PanelController } from "@/controller";
import "@/globals.css";

function mountPoint() {
  const existing = document.getElementById("root");
  if (existing) return existing;
  // Rendering a readable failure beats throwing into a blank side panel.
  const created = document.createElement("div");
  created.id = "root";
  document.body.append(created);
  return created;
}

// panel.html loads panel-logic.js and tokenpath.js as plain script tags before
// this bundle. If either failed, the controller would throw on construction
// and leave nothing on screen at all.
const missingScripts = [
  typeof TldrPanelLogic === "undefined" ? "panel-logic.js" : null,
  typeof TokenPath === "undefined" || typeof formatTokens === "undefined"
    ? "tokenpath.js"
    : null,
].filter((name): name is string => name !== null);

const root = createRoot(mountPoint());

if (missingScripts.length > 0) {
  root.render(
    <PanelFailure
      detail={`The panel could not load ${missingScripts.join(" and ")}. Close the side panel and open it again.`}
      title="The panel didn't finish loading"
    />
  );
} else {
  const controller = new PanelController();
  const clearHighlightsWhenHidden = () => {
    if (document.visibilityState === "hidden") controller.clearHighlights();
  };

  // pagehide covers every side-panel teardown Chrome fires; the deprecated
  // unload event only duplicated it.
  window.addEventListener("pagehide", () => controller.dispose(), {
    once: true,
  });
  document.addEventListener("visibilitychange", clearHighlightsWhenHidden);

  const initialized = controller.init().catch(() => undefined);
  root.render(
    <PanelErrorBoundary>
      <App controller={controller} initialized={initialized} />
    </PanelErrorBoundary>
  );
}
