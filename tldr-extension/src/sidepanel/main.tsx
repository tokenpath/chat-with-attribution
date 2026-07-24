import { createRoot } from "react-dom/client";
import { App } from "@/app";
import { PanelController } from "@/controller";
import "@/globals.css";

const controller = new PanelController();
const root = document.getElementById("root");

if (!root) {
  throw new Error("TLDR side-panel root was not found.");
}

createRoot(root).render(<App controller={controller} />);
void controller.init();
