# Security policy

This policy follows ISO/IEC 29147 (vulnerability disclosure) and ISO/IEC 30111 (vulnerability handling processes).

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub instead: go to the repository's **Security** tab and choose **Report a vulnerability**.

Include:

- Extension version and Chrome version
- Steps to reproduce, or a proof of concept
- What an attacker could achieve

## What happens next

| Step | Target time |
| --- | --- |
| Acknowledge the report | 7 days |
| Confirm or reject it, and agree on severity with you | 14 days |
| Release a fix for a confirmed issue | 90 days |
| Publish a GitHub Security Advisory (with a CVE where warranted) | When the fix is released |

We keep you informed at each step, coordinate the disclosure date with you, and credit you in the advisory unless you prefer to stay anonymous. If a fix cannot be released in 90 days, we tell you why and agree on a new date.

## Scope

The extension runs a script in YouTube's page context (`world: "MAIN"`) and holds only the `storage` permission. Issues of particular interest:

- Ways for a web page to change the extension's settings or inject markup through it
- Messages accepted from origins other than the page's own
- Anything that sends user data outside YouTube

Out of scope: problems in YouTube or Chrome themselves, which should be reported to Google.
