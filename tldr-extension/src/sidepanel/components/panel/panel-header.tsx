import {
  EraserIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { PanelController, PanelSnapshot } from "@/controller";
import { cn } from "@/lib/utils";

function TokenPathWordmark() {
  return (
    <span aria-hidden="true" className="tokenpath-wordmark">
      <span className="tokenpath-wordmark-token">token</span>
      <span className="tokenpath-wordmark-path">path</span>
    </span>
  );
}

function ThemeIcon({ snapshot }: { snapshot: PanelSnapshot }) {
  if (snapshot.themePreference === "system") {
    return <MonitorIcon className="size-3.5" />;
  }
  return snapshot.resolvedTheme === "dark" ? (
    <MoonIcon className="size-3.5" />
  ) : (
    <SunIcon className="size-3.5" />
  );
}

function nextThemeLabel(snapshot: PanelSnapshot) {
  const next = {
    system: "light",
    light: "dark",
    dark: "system",
  }[snapshot.themePreference];
  return `Theme: ${snapshot.themePreference}. Switch to ${next}.`;
}

export function PanelHeader({
  controller,
  settingsButtonRef,
  snapshot,
}: {
  controller: PanelController;
  settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  snapshot: PanelSnapshot;
}) {
  const chatIsEmpty = snapshot.messages.every(
    (message) => message.kind === "note"
  );

  return (
    <header className="panel-header flex h-12 shrink-0 items-center justify-between px-3.5">
      <div className="brand-lockup">
        <a
          aria-label="Visit TokenPath (opens in a new tab)"
          className="tokenpath-wordmark-link"
          href="https://tokenpath.ai"
          rel="noopener noreferrer"
          target="_blank"
        >
          <TokenPathWordmark />
        </a>
        <span aria-hidden="true" className="brand-divider">
          /
        </span>
        <span className="product-name" title="Browse with TokenPath">
          Chat
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="token-badge"
          hidden={!snapshot.creditsText}
          id="credits"
          title="TokenPath tokens remaining"
        >
          {snapshot.creditsText}
        </span>
        <Button
          aria-label={nextThemeLabel(snapshot)}
          id="theme-toggle"
          onClick={controller.cycleTheme}
          size="icon-xs"
          title={nextThemeLabel(snapshot)}
          variant="ghost"
        >
          <ThemeIcon snapshot={snapshot} />
        </Button>
        <Button
          aria-controls="settings"
          aria-expanded={snapshot.settingsOpen}
          aria-label={snapshot.settingsOpen ? "Close settings" : "Open settings"}
          className={cn(
            snapshot.settingsOpen && "bg-accent text-accent-foreground"
          )}
          id="settings-toggle"
          onClick={controller.toggleSettings}
          ref={settingsButtonRef}
          size="icon-xs"
          title={snapshot.settingsOpen ? "Close settings" : "Settings"}
          variant="ghost"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Clear source highlight"
          className="gap-1.5 px-2"
          id="clear-hl"
          onClick={controller.clearHighlights}
          size="sm"
          title="Clear source highlight"
          variant="outline"
        >
          <EraserIcon className="size-3.5" />
          <span className="hidden min-[470px]:inline">Clear highlight</span>
        </Button>
        <Button
          aria-label="Clear chat for this page"
          className="gap-1.5 px-2"
          disabled={snapshot.busy || chatIsEmpty}
          id="clear-chat"
          onClick={() => void controller.clearConversation()}
          size="sm"
          title="Clear chat for this page"
          variant="outline"
        >
          <Trash2Icon className="size-3.5" />
          <span className="hidden min-[470px]:inline">Clear chat</span>
        </Button>
      </div>
    </header>
  );
}
