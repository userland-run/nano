# License

**NanoVM** — the userland.run RISC-V/Linux userland emulator
(<https://userland.run>) — is **dual-licensed**. You may use, modify, and
distribute it under the terms of **either**:

- the **GNU Affero General Public License, version 3** (AGPL-3.0) — the
  open-source option; the full text is in [`LICENSE`](./LICENSE); or
- the **Userland Enterprise License** (UEL) — a commercial option available
  from **And The Next GmbH**.

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL`

Source files carry the license notice in their header; new files must include
it (copy it from any existing source file).

## Why AGPL here (and MPL for the SDK)

The userland.run user-facing projects — the emulator (`nano`), the terminal,
and the surrounding specs and design system — are delivered as end-user
software, typically over a network, so they use the **AGPL**: its §13 network
clause requires anyone running a *modified* version as a hosted service to offer
that service's complete source to its users. The embeddable **SDK**
(`@userland-run/nano-sdk`) is instead **MPL-2.0**, deliberately more permissive
so it can be embedded broadly. Both are available under the commercial **UEL**
for users who need terms the open-source licenses don't provide.

## GNU Affero General Public License v3 (open source)

The standard, **unmodified** AGPL-3.0 governs — see [`LICENSE`](./LICENSE), or
obtain a copy at <https://www.gnu.org/licenses/agpl-3.0.html>. The AGPL's
copyleft is strong and whole-work: a work that combines or links these files is
itself subject to the AGPL, and §13 extends that to use over a network.

## Userland Enterprise License (commercial)

A commercial license is available from **And The Next GmbH** for users who need
terms AGPL-3.0 does not provide — for example the right to build closed-source
or hosted derivatives **without** the AGPL's reciprocity and network-source
obligations, plus warranty, indemnification, liability cover, support SLAs, and
patent assurances. Contact And The Next GmbH for terms.

## Bundled third-party components

This repository redistributes some unmodified third-party components under their
own licenses. Those terms govern those files; see [`NOTICE`](./NOTICE).

## Contributions

Contributions are accepted under the project's Contributor License Agreement,
which lets And The Next GmbH distribute them under **both** the AGPL-3.0 and the
Userland Enterprise License. See [`CLA.md`](./CLA.md).

## Trademarks

`userland`, `userland.run`, and the userland.run logo are trademarks of And The
Next GmbH. The open-source license grants copyright permissions, not trademark
permissions: you may use and modify the software, but you may not ship a
derivative *called* userland without permission.

© And The Next GmbH. All rights reserved except as expressly granted above.
