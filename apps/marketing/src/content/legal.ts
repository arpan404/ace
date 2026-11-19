import { contact } from "../site.ts";

/*
 * The privacy policy and terms of service. The facts here follow the account and relay design
 * (docs/adr 0106, 0110 and 0111): when what a service stores or sees changes, change this too
 * and move `updated` forward.
 */

/** A paragraph, or a list of short points. */
export type LegalBlock = string | { list: string[] };

export interface LegalDocument {
  path: string;
  /** The page's one H1. */
  headline: string;
  /** The <title>. */
  title: string;
  /** The meta description, at most about 160 characters. */
  description: string;
  /** When this version took effect, as written on the page. */
  updated: string;
  /** Machine-readable form of `updated`. */
  updatedIso: string;
  intro: string;
  sections: { heading: string; body: LegalBlock[] }[];
}

const updated = "3 November 2026";
const updatedIso = "2026-11-03";

export const privacyPolicy: LegalDocument = {
  path: "/privacy-policy/",
  headline: "Privacy policy",
  title: "Privacy policy: what ace collects and why",
  description:
    "What the ace account, relay, push gateway and website collect, how it is used, who processes it and how to delete it. ace never sees your code or prompts.",
  updated,
  updatedIso,
  intro:
    "ace is an open-source app that runs coding agents on your own computers. Most of ace never talks to us at all. This policy covers the few services we run: the ace account, the hosted relay, the push gateway for iPhone and iPad, this website (acehq.dev) and the web app (app.acehq.dev).",
  sections: [
    {
      heading: "The short version",
      body: [
        {
          list: [
            "Your code, prompts, transcripts and files stay on your machines. We never receive them.",
            "We never ask for, store or pass on the credentials of your coding agents (Claude, Codex, Cursor and the others).",
            "An ace account is optional. If you create one, we keep your account id, email and name, and a short record of each machine you sign in.",
            "Traffic through our relay is end-to-end encrypted between your devices and your machines. We can't read it.",
            "We don't sell data, show ads, use trackers or train AI models on anything of yours.",
          ],
        },
      ],
    },
    {
      heading: "What stays on your machines",
      body: [
        "The ace desktop app and its daemon run on your computers. Your threads, prompts, agent transcripts, code, terminals, worktrees, files and settings are stored there, and never sent to us.",
        "Each coding agent runs through its own CLI, signed in with your account at that provider. What the agent sends to its provider (for example Anthropic, OpenAI or Cursor) is governed by that provider's terms and privacy policy, not this one. ace doesn't add a copy on the way.",
      ],
    },
    {
      heading: "Your ace account",
      body: [
        "You need an ace account only to reach your machines through our hosted relay. Everything else in ace, including pairing over your local network or Tailscale and running your own relay, works without one.",
        "Sign-in is handled by WorkOS, with an email address, Google or GitHub. When you sign in, WorkOS gives us your account id, email address and name. With Google or GitHub, ace asks only for basic profile access (your name and email address), and uses it only to identify your account and show who is signed in. We don't read your repositories, contacts or anything else in those accounts.",
        "Our account database (Cloudflare D1) holds:",
        {
          list: [
            "Your account id, email address and name.",
            "Your ace sessions, stored only as one-way hashes, so a database copy can't be used to sign in.",
            "WorkOS refresh tokens, encrypted, so your sessions can be renewed.",
            "Sign-ins in progress, which expire after ten minutes and are deleted within the hour.",
          ],
        },
        "During sign-in, our sign-in page sets one short-lived cookie that ties the sign-in to your browser. It is used for nothing else.",
      ],
    },
    {
      heading: "Machines on your account",
      body: [
        "For each machine you sign in to your account, we store its host id (a fingerprint of the machine's public key), its name, its platform (such as macOS or Linux), and when it was first and last seen. We use this to list your machines in the apps and to make sure only your account's devices can reach them.",
        "If you set a machine code on a machine, it is checked by that machine alone, inside the encrypted connection. We never see it.",
      ],
    },
    {
      heading: "The hosted relay",
      body: [
        "When a device and a machine can't reach each other directly, ace connects them through our relay on Cloudflare. The connection is end-to-end encrypted between the two ends, so the relay forwards data it can't read: never your prompts, code, transcripts, files or screens.",
        "To route a connection, the relay sees the IP addresses of both ends, the machine's host id, a short-lived signed pass (valid for five minutes) showing that the device and the machine belong to the same account, when the connection opens and closes, and the size of the encrypted messages. It keeps none of this after the connection ends, and it logs no messages, passes or addresses.",
      ],
    },
    {
      heading: "Notifications on iPhone and iPad",
      body: [
        "If you turn on notifications in ace for iPhone or iPad, your machines send alerts through ace's push gateway to Apple's push notification service. Each alert is encrypted on your machine so that only your phone can read it. The gateway sees your phone's push token, the sending machine's public key and IP address, and the time, size and urgency of each alert. It has no database, and it logs only counts and status codes.",
      ],
    },
    {
      heading: "This website and the web app",
      body: [
        "acehq.dev has no analytics, no advertising and no tracking cookies. It remembers your light or dark theme in your browser's storage. To show the newest download, your browser may ask GitHub for the latest release, and GitHub sees that request.",
        "The web app at app.acehq.dev runs in your browser and connects to your own machines. It keeps its settings, your ace session and a random device id in your browser's storage.",
        "Both sites are served by Cloudflare, which processes visitors' IP addresses to deliver pages and protect against abuse.",
      ],
    },
    {
      heading: "Downloads and updates",
      body: [
        "ace's installers and updates are published on GitHub. When you download ace or the desktop app checks for an update, GitHub receives that request under its own privacy policy. ace sends no usage statistics or crash reports.",
      ],
    },
    {
      heading: "How we use this information",
      body: [
        "Only to run the services above: to sign you in, list your machines, connect your devices to them, deliver your notifications, and protect the services, for example by limiting how many requests one address can make. We don't sell or rent personal information, use it for advertising, or use it to train AI models.",
      ],
    },
    {
      heading: "Who processes it",
      body: [
        {
          list: [
            "WorkOS: sign-in and account management.",
            "Cloudflare: hosting for this website, the web app, the account service, its database and the relay.",
            "Google and GitHub: only if you choose to sign in with them.",
            "Apple: delivering notifications to iPhone and iPad.",
            "GitHub: downloads, updates and source code.",
          ],
        },
        "These providers may process data in the United States and other countries. We share personal information with nobody else, unless the law requires it.",
      ],
    },
    {
      heading: "How long we keep it",
      body: [
        {
          list: [
            "Your account and its machines: until you delete them.",
            "Sessions: until you sign out or they expire.",
            "Sign-ins in progress: up to an hour.",
            "Relay connections and notifications: nothing is kept after delivery.",
          ],
        },
      ],
    },
    {
      heading: "Your choices",
      body: [
        "You can use ace without an account. You can change your name in Settings, and sign a machine out in its Settings or with `ace logout`. Signing out ends that session at once; a removed device loses access to your machines within five minutes.",
        `To see the data we hold about you, correct it, remove machines from your account, or delete your account, email ${contact.email} from the address on your account. We delete your account, its machines and sessions from our database, and your user from WorkOS, within 30 days. Depending on where you live, you may have further rights under laws such as the GDPR or CCPA; write to us and we will honour them.`,
      ],
    },
    {
      heading: "Security",
      body: [
        "Device-to-machine traffic is end-to-end encrypted, sessions are stored only as hashes, and refresh tokens are encrypted at rest. ace is open source, so you can read exactly what each service does on GitHub.",
      ],
    },
    {
      heading: "Children",
      body: [
        "ace is a tool for software developers and isn't meant for children under 13, or under 16 in the European Economic Area. We don't knowingly collect their information; if you believe we have, email us and we will delete it.",
      ],
    },
    {
      heading: "Changes to this policy",
      body: [
        "If we change what we collect or how we use it, we will update this page and the date at the top. For significant changes, we will also say so on this site or in the app before they take effect.",
      ],
    },
    {
      heading: "Contact",
      body: [`Questions about privacy, or a request about your data: ${contact.email}.`],
    },
  ],
};

export const termsOfService: LegalDocument = {
  path: "/terms-of-service/",
  headline: "Terms of service",
  title: "Terms of service: using ace and its services",
  description:
    "The terms for using ace, the ace account and ace's hosted relay: acceptable use, your responsibilities, no warranty, and how accounts end.",
  updated,
  updatedIso,
  intro:
    "These terms apply when you use ace's apps or the services we run for them: the ace account, the hosted relay, the push gateway, this website and the web app. By using them, you agree to these terms.",
  sections: [
    {
      heading: "The software",
      body: [
        "ace's source code is open source under the Apache-2.0 license, and that license governs the code: you may use, change and share it under its terms. These terms cover the services we host. You can run ace without them, or run your own relay instead of ours.",
      ],
    },
    {
      heading: "Your account",
      body: [
        "Give accurate information when you sign in, keep your sign-in methods secure, and tell us if you think someone else has used your account. You are responsible for what happens under your account.",
        "A device signed in to your account can control every machine on it, unless that machine has a machine code. Set a machine code on machines that matter, and turn on multi-factor sign-in where you can.",
      ],
    },
    {
      heading: "Your machines and your agents",
      body: [
        "ace runs coding agents on computers you control, through CLIs you install and sign in to. You decide what those agents may do, and you are responsible for their actions on your machines and for following the terms of each agent's provider. ace doesn't control those providers or their models, and isn't responsible for their output.",
      ],
    },
    {
      heading: "Acceptable use",
      body: [
        "Don't use ace's services to:",
        {
          list: [
            "break the law, or infringe anyone's rights;",
            "reach machines, accounts or data that aren't yours, or that you aren't allowed to use;",
            "spread malware, or attack, probe or overload any system, ours included;",
            "use the relay for anything other than connecting your own devices to your own machines;",
            "get around rate limits, access checks or other protections.",
          ],
        },
      ],
    },
    {
      heading: "The services",
      body: [
        "The hosted services are currently free, and offered as they are. We may change them, limit their use, or stop offering them, and they may sometimes be unavailable. When the relay is down, connections over your local network, Tailscale or your own relay keep working.",
      ],
    },
    {
      heading: "Ending your use",
      body: [
        "You can stop using the services and ask us to delete your account at any time (see the privacy policy). We may suspend or close an account that breaks these terms or puts the services or other people at risk, and, where we reasonably can, we will tell you why.",
      ],
    },
    {
      heading: "Third-party services",
      body: [
        "Signing in uses WorkOS, and Google or GitHub if you choose them. The services run on Cloudflare, and notifications go through Apple. Your coding agents connect to their own providers. Each of these has its own terms, which apply to your use of it.",
      ],
    },
    {
      heading: "No warranty",
      body: [
        'ace and its services are provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. We don\'t promise that they will be uninterrupted, secure or free of errors.',
      ],
    },
    {
      heading: "Limitation of liability",
      body: [
        "To the extent the law allows, ace and its contributors are not liable for any indirect, incidental, special or consequential damages, or for lost data, profits or work, arising from your use of ace or its services. Our total liability for any claim about the services is limited to 100 US dollars.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: [
        "We may update these terms. We will change the date at the top and, for significant changes, say so on this site or in the app before they take effect. If you keep using the services after that, the new terms apply.",
      ],
    },
    {
      heading: "Contact",
      body: [`Questions about these terms: ${contact.email}.`],
    },
  ],
};

export const legalDocuments = [privacyPolicy, termsOfService];
