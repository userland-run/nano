// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

import { createRoot } from "react-dom/client";
import App from "./App";
import "@react-spectrum/s2/page.css";

createRoot(document.getElementById("root")!).render(
  <App />
);
