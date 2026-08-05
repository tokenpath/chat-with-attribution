import { KeyRoundIcon } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  planTerms,
  type PanelController,
  type PanelSnapshot,
} from "@/controller";

function Step({
  children,
  number,
  title,
}: {
  children: ReactNode;
  number: number;
  title: string;
}) {
  return (
    <li className="grid grid-cols-[1.15rem_minmax(0,1fr)] gap-x-2">
      <span aria-hidden="true" className="auth-step-number">
        {number}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium leading-[1.15rem]">{title}</div>
        {children}
      </div>
    </li>
  );
}

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
  // Nobody is connected while this is on screen, so the subscription has never
  // been read; planTerms falls back to the shipped price for exactly that.
  const { price } = planTerms(snapshot.subscription);

  return (
    <section
      className="auth-panel border-b border-border p-3"
      hidden={snapshot.connected}
      id="auth"
    >
      <div className="mb-3 flex items-start gap-2.5">
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

      <ol className="grid gap-3">
        <Step number={1} title="Create a free TokenPath account">
          <p className="mt-0.5 text-[0.7rem] leading-4 text-muted-foreground">
            New accounts get{" "}
            {TokenPath.SIGNUP_GRANT_TOKENS.toLocaleString("en-US")} free tokens.
          </p>
          <a
            className="brand-link mt-1 inline-block text-[0.7rem] font-medium"
            href={TokenPath.PLATFORM_URL}
            id="auth-signup-link"
            rel="noopener noreferrer"
            target="_blank"
          >
            Create a free account ↗
          </a>
        </Step>

        <Step number={2} title="Create an API key and paste it here">
          <a
            className="brand-link mt-1 inline-block text-[0.7rem] font-medium"
            href={TokenPath.API_KEYS_URL}
            id="auth-keys-link"
            rel="noopener noreferrer"
            target="_blank"
          >
            Open your API keys ↗
          </a>
          <form
            className="mt-1.5 grid gap-2"
            id="auth-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const connected = await controller.connect(tokenPathKey);
              if (connected) setTokenPathKey("");
            }}
          >
            {/*
              The step heading already says what the field is for, so the label
              would only repeat it on screen; it stays for the accessible name.
            */}
            <label className="sr-only" htmlFor="tokenpath-key">
              TokenPath API key
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
        </Step>
      </ol>

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

      <div className="mt-3 text-[0.7rem] leading-4 text-muted-foreground">
        <div id="auth-plan-note">
          When those run out, {price}/month keeps this extension refilled.
        </div>
        <div className="mt-1">
          TokenPath receives the website origin, captured page or PDF text, your
          questions, and generated answers.
        </div>
      </div>
    </section>
  );
}
