import { DesktopTowerIcon, GlobeIcon, UserCircleIcon } from "@ace/icons";
import { useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { ChoiceList, ChoiceRow } from "@/components/choice-row.tsx";
import { FirstRunFrame } from "@/components/first-run-frame.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useAceAccount, useAceAccountStore } from "@/features/ace-account/index.ts";
import { AccountMachines, AddMachineDialog, type MachineWay } from "@/features/settings/index.ts";

/**
 * A window with no machine: threads run on one, so it asks for one the way first-run setup
 * does. Signed in, the machines on the ace account open from here; otherwise Sign in to ace
 * (a build without accounts leaves it out), pair with a code, or connect by address.
 */
export function NoMachineThreads() {
  const store = useAceAccountStore();
  const { session, restoring, signIn, error } = useAceAccount();
  const [adding, setAdding] = useState<MachineWay>();
  const signingIn = signIn !== null;
  return (
    <FirstRunFrame
      page="connect"
      title="Connect to a machine"
      lede="ace runs on a computer with your coding agents. Connect this window to one."
    >
      <div className="flex flex-col gap-6">
        {session && (
          <section aria-label="Your machines" className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-muted-foreground">
              On {session.account.email ?? "your ace account"}
            </h2>
            <AccountMachines />
          </section>
        )}
        <ChoiceList label="Ways to connect" {...(session ? { heading: "Add another" } : {})}>
          {store && !session && !restoring && (
            <ChoiceRow
              icon={UserCircleIcon}
              label={signingIn ? "Finishing sign-in in your browser" : "Sign in to ace"}
              hint={error || "Open the machines on your ace account"}
              onClick={() => {
                if (!signingIn) store.signIn((address) => openExternalWhenReady(address));
              }}
            />
          )}
          <ChoiceRow
            icon={DesktopTowerIcon}
            label="Pair with a code"
            hint="From Settings › Fleet on the computer running ace"
            onClick={() => setAdding("pair")}
          />
          <ChoiceRow
            icon={GlobeIcon}
            label="Connect by address"
            hint="Its address and access token"
            onClick={() => setAdding("address")}
          />
        </ChoiceList>
        {signingIn && store && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => store.cancelSignIn()}>
              Stop signing in
            </Button>
          </div>
        )}
      </div>
      <AddMachineDialog way={adding} close={() => setAdding(undefined)} />
    </FirstRunFrame>
  );
}
