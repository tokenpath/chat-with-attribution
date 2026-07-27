import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { PanelController } from "@/controller";
import "@/globals.css";

const controller = new PanelController();
const root = document.getElementById("root");
const disposeController = () => controller.dispose();

if (!root) {
  throw new Error("TokenPath side-panel root was not found.");
}

window.addEventListener("pagehide", disposeController, { once: true });
window.addEventListener("unload", disposeController, { once: true });

createRoot(root).render(<App controller={controller} />);
void controller.init();
