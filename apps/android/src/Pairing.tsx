import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { ConfirmedPairing } from "./pairing/pairing-flow.ts";
import {
  PAIRING_UNAVAILABLE_MESSAGE,
  SCAN_FAILED_MESSAGE,
  SCAN_UNAVAILABLE_MESSAGE,
  acceptPairingText,
  canStartPairing,
  pairingFailureMessage,
} from "./pairing/pairing-view.ts";
import { AceButton } from "./components.tsx";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";

/**
 * Scan or paste the link from `ace pair`, then confirm before anything is sent.
 *
 * Mirrors the iOS `PairingView`/`ConfirmPairingView`
 * (`apps/ios/Sources/Views/Pairing/PairingView.swift`): the entry state only
 * parses the link for the confirm screen (address, grant, fingerprint); the
 * one-use code is redeemed exactly once, on the explicit Pair action, through
 * the injected `pair` callback over the pinned transport. Scanned QR text
 * takes the same parse path as pasted text, so there is no second redemption
 * path. When `pair` (or `scan`) is absent the corresponding action stays
 * disabled with guidance, and no secret or code can leave the phone: parsing
 * performs no networking and the screen never touches a transport itself.
 *
 * Fail-closed lifecycle, mirroring iOS `interactiveDismissDisabled(pairing)`:
 * there is no cancel while pairing — Back stays disabled and unmounting
 * never claims to cancel the request, because the native bridge cannot
 * cancel an in-flight redemption and the one-use code may already be burned.
 * Late settlements after unmount update no state; a completed pairing still
 * reports through `onPaired` so a burned code is never silently dropped.
 * Failures show only mapped copy (`pairingFailureMessage`): raw transport or
 * scanner text may echo link material and is never displayed.
 *
 * Layout follows the proven Android patterns (plain React Native views and
 * inputs as in `ConversationSearch.tsx`, compose buttons through `AceHost`
 * as in `Files.tsx`): no compose containers wrap native inputs.
 */
export function PairingScreen({
  defaultDeviceName = "",
  scan,
  pair,
  onPaired,
}: {
  defaultDeviceName?: string;
  /** Camera capture returning decoded QR text, or null when cancelled. Absent until camera wiring lands. */
  scan?: (() => Promise<string | null>) | undefined;
  /** Redeem a confirmed link exactly once over the pinned transport. Absent until production wiring lands. */
  pair?:
    | ((confirmed: ConfirmedPairing, name: string, signal?: AbortSignal) => Promise<void>)
    | undefined;
  onPaired(): void;
}) {
  const [pasted, setPasted] = useState("");
  const [confirmed, setConfirmed] = useState<ConfirmedPairing | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [name, setName] = useState(defaultDeviceName);
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const style = usePairingStyles();

  if (confirmed !== null) {
    return (
      <ConfirmPairingScreen
        confirmed={confirmed}
        name={name}
        pairing={pairing}
        failure={failure}
        unavailable={pair === undefined ? PAIRING_UNAVAILABLE_MESSAGE : null}
        onName={setName}
        onBack={() => {
          if (!pairing) {
            setConfirmed(null);
            setFailure(null);
          }
        }}
        onPair={() => {
          if (pair === undefined || !canStartPairing(name, pairing)) return;
          const controller = new AbortController();
          setPairing(true);
          setFailure(null);
          void pair(confirmed, name.trim(), controller.signal)
            .then(() => {
              if (!mounted.current) {
                onPaired();
                return;
              }
              setPasted("");
              setConfirmed(null);
              setPairing(false);
              onPaired();
            })
            .catch((error: unknown) => {
              if (!mounted.current) return;
              setFailure(pairingFailureMessage(error));
              setPairing(false);
            });
        }}
      />
    );
  }

  const accept = (text: string) => {
    const accepted = acceptPairingText(text);
    if (accepted.ok) {
      setConfirmed(accepted.confirmed);
      setEntryError(null);
    } else {
      setEntryError(accepted.entryError);
    }
  };
  const canContinue = pasted.trim() !== "" && !scanning;
  const canScan = scan !== undefined && !scanning;
  return (
    <PairingLayout title="Pair a machine">
      <Text style={style.helper}>
        On your computer, run `ace pair` or open Settings › Machines and devices and create a
        pairing link.
      </Text>
      <AceHost style={{ width: "100%" }}>
        <AceButton
          label={scanning ? "Opening camera…" : "Scan pairing QR code"}
          enabled={canScan}
          onPress={() => {
            const capture = scan;
            if (capture === undefined || scanning) return;
            setScanning(true);
            void capture()
              .then((value) => {
                if (!mounted.current) return;
                if (value !== null) accept(value);
              })
              .catch(() => {
                if (!mounted.current) return;
                setEntryError(SCAN_FAILED_MESSAGE);
              })
              .finally(() => {
                if (mounted.current) setScanning(false);
              });
          }}
        />
      </AceHost>
      {scan === undefined ? <Text style={style.helper}>{SCAN_UNAVAILABLE_MESSAGE}</Text> : null}
      <Text style={style.sectionLabel}>Or paste the link</Text>
      <TextInput
        accessibilityLabel="pairing.link"
        placeholder="https://…/pair#…"
        placeholderTextColor={style.placeholder}
        value={pasted}
        onChangeText={setPasted}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        keyboardType="url"
        multiline
        style={style.input}
      />
      <AceHost style={{ width: "100%" }}>
        <AceButton
          label="Continue"
          enabled={canContinue}
          onPress={() => {
            if (canContinue) accept(pasted);
          }}
        />
      </AceHost>
      {entryError !== null ? (
        <Text style={style.error} accessibilityLabel="pairing.entryError">
          {entryError}
        </Text>
      ) : null}
    </PairingLayout>
  );
}

/** The host chose the grant; the person confirms the computer and names this phone. */
function ConfirmPairingScreen({
  confirmed,
  name,
  pairing,
  failure,
  unavailable,
  onName,
  onBack,
  onPair,
}: {
  confirmed: ConfirmedPairing;
  name: string;
  pairing: boolean;
  failure: string | null;
  unavailable: string | null;
  onName(name: string): void;
  onBack(): void;
  onPair(): void;
}) {
  const style = usePairingStyles();
  const ready = unavailable === null && canStartPairing(name, pairing);
  return (
    <PairingLayout title="Confirm computer">
      <View style={style.card}>
        <View style={style.row}>
          <Text style={style.fieldLabel}>Address</Text>
          <Text style={style.rowValue}>{confirmed.displayHost}</Text>
        </View>
        <View style={style.row}>
          <Text style={style.fieldLabel}>Access</Text>
          <Text style={style.rowValue}>{confirmed.accessSummary}</Text>
        </View>
        <View>
          <Text style={style.fieldLabel}>Fingerprint</Text>
          <Text style={style.fingerprint} selectable accessibilityLabel="pairing.fingerprint">
            {confirmed.fingerprintGroups}
          </Text>
        </View>
      </View>
      <Text style={style.helper}>
        Check that the fingerprint matches the link on your computer. ace only talks to the computer
        holding this key.
      </Text>
      <Text style={style.sectionLabel}>This phone&apos;s name</Text>
      <TextInput
        accessibilityLabel="pairing.name"
        placeholder="My phone"
        placeholderTextColor={style.placeholder}
        value={name}
        onChangeText={onName}
        autoCapitalize="words"
        autoCorrect={false}
        editable={!pairing}
        style={style.input}
      />
      {failure !== null ? (
        <Text style={style.error} accessibilityLabel="pairing.error">
          {failure}
        </Text>
      ) : null}
      {unavailable !== null ? <Text style={style.helper}>{unavailable}</Text> : null}
      <AceHost style={{ width: "100%" }}>
        <AceButton
          label={pairing ? "Pairing…" : "Pair this phone"}
          enabled={ready}
          onPress={() => {
            if (ready) onPair();
          }}
        />
      </AceHost>
      <AceHost style={{ width: "100%" }}>
        <AceButton label="Back to link" kind="secondary" enabled={!pairing} onPress={onBack} />
      </AceHost>
    </PairingLayout>
  );
}

function PairingLayout({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colours.background }}
      contentContainerStyle={{ padding: tokens.spacing.xl, gap: tokens.spacing.md }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ ...textStyle("title"), color: theme.colours.foreground }}>{title}</Text>
      {children}
    </ScrollView>
  );
}

function usePairingStyles() {
  const theme = useTheme();
  return {
    placeholder: theme.colours.mutedForeground,
    helper: { ...textStyle("caption"), color: theme.colours.mutedForeground },
    sectionLabel: { ...textStyle("label"), color: theme.colours.foreground },
    fieldLabel: { ...textStyle("label"), color: theme.colours.mutedForeground },
    rowValue: {
      ...textStyle("body"),
      color: theme.colours.foreground,
      flexShrink: 1 as const,
      textAlign: "right" as const,
    },
    row: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      gap: tokens.spacing.md,
    },
    card: {
      backgroundColor: theme.colours.secondaryBackground,
      borderRadius: tokens.radii.group,
      padding: tokens.spacing.md,
      gap: tokens.spacing.md,
    },
    fingerprint: { ...textStyle("code"), color: theme.colours.foreground },
    input: {
      ...textStyle("body"),
      color: theme.colours.foreground,
      backgroundColor: theme.colours.card,
      borderRadius: tokens.radii.composer,
      borderWidth: tokens.dimensions.border,
      borderColor: theme.colours.separator,
      paddingHorizontal: tokens.spacing.md,
      minHeight: tokens.dimensions.touchTarget,
    },
    error: { ...textStyle("body"), color: theme.statusText.failed },
  };
}
