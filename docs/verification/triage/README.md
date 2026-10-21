# Triage verification

The app was checked against the fake daemon at 390, 768, 1440 and 1920 CSS pixels
in light and dark schemes. Prompt generation, provider selection, editing, copying
and the launch-failure fallback were exercised. Settings > Advanced was checked
through checks, repairs and a prompt containing the fresh doctor results. The
browser console reported no errors.

![Prompt preview on desktop in light mode](preview-light.jpg)

![Prompt preview on a phone in dark mode](preview-dark-phone.jpg)

The CLI and socket process tests use temporary homes and local stub executables.
They cover literal prompt arguments, terminal input and exit status, repairs that
preserve existing data, refusal of linked repair targets, access control and the
absence of durable command records. They do not launch a real provider session.

The full-daemon terminal test found that passing Node's `process.env` object into
the terminal schema failed validation. The launch now passes a plain environment
copy. The support-export test also subscribed to the socket's open event after
an asynchronous token read; reading the token first removes that event race.
