import { type ComponentProps, Profiler } from "react";

import { isRenderProfilingEnabled, recordReactRenderProfile } from "../../lib/renderProfiling";
import { InAppBrowser } from "../InAppBrowser";

export type BrowserPanelInstance = {
  key: string;
  inAppBrowserProps: ComponentProps<typeof InAppBrowser>;
};

export function RetainedBrowserInstances({
  instances,
}: {
  instances: readonly BrowserPanelInstance[];
}) {
  const content = (
    <>
      {instances.map((instance) => (
        <InAppBrowser key={instance.key} {...instance.inAppBrowserProps} />
      ))}
    </>
  );

  return isRenderProfilingEnabled() ? (
    <Profiler
      id="retained-browser-instances"
      onRender={(_id, phase, actualDuration) => {
        recordReactRenderProfile("retained-browser-instances", phase, actualDuration);
      }}
    >
      {content}
    </Profiler>
  ) : (
    content
  );
}
