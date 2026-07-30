import { KeyRoundIcon } from "lucide-react";
import { useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { PanelController, PanelSnapshot } from "@/controller";

export function AuthPanel({
  controller,
  keyInputRef,
  snapshot,
}: {
  controller: PanelController;
  keyInputRef: RefObject<HTMLInputElement | null>;
  snapshot: PanelSnapshot;
}) {
  const [tokenPathKey, setTokenPathKey] = useState("");

  return (
    <section
      className="auth-panel border-b border-border p-3"
      hidden={snapshot.connected}
      id="auth"
    >
      <div className="mb-2.5 flex items-start gap-2.5">
        <div className="auth-key-icon mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border">
          <KeyRoundIcon className="size-3.5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Connect TokenPath</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            One key generates the answer and maps it back to the source.
          </p>
        </div>
      </div>
      <form
        className="grid gap-2"
        id="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const connected = await controller.connect(tokenPathKey);
          if (connected) setTokenPathKey("");
        }}
      >
        <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2">
          <label
            className="text-[0.7rem] font-medium text-muted-foreground"
            htmlFor="tokenpath-key"
          >
            TokenPath
          </label>
          <Input
            aria-label="TokenPath API key"
            autoComplete="off"
            className="min-w-0 font-mono text-xs"
            disabled={snapshot.authBusy}
            id="tokenpath-key"
            onChange={(event) => setTokenPathKey(event.currentTarget.value)}
            placeholder={
              snapshot.connected ? "Saved — leave blank to keep" : "tpk_live_…"
            }
            ref={keyInputRef}
            spellCheck={false}
            type="password"
            value={tokenPathKey}
          />
        </div>
        <Button
          disabled={
            snapshot.authBusy || (!snapshot.connected && !tokenPathKey.trim())
          }
          id="auth-connect"
          size="sm"
          type="submit"
        >
          {snapshot.authBusy ? <Spinner /> : "Connect"}
        </Button>
      </form>
      {/*
        The announcement lives in the always-mounted live region at the app
        root: this container is hidden whenever the panel is connected, and a
        live region inside a hidden subtree is never announced.
      */}
      <div
        className="mt-2 text-xs text-destructive"
        hidden={!snapshot.authError}
        id="auth-error"
      >
        {snapshot.authError}
      </div>
      <div className="mt-2.5 text-[0.7rem] leading-4 text-muted-foreground">
        <div>
          TokenPath receives the website origin, captured page or PDF text, your
          questions, and generated answers.
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <a
            className="brand-link font-medium"
            href="https://platform.tokenpath.ai"
            rel="noopener noreferrer"
            target="_blank"
          >
            Get a free API key ↗
          </a>
        </div>
      </div>
    </section>
  );
}
