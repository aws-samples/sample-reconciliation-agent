import { redirect } from "next/navigation";

import { CONSOLE_SETTINGS_PATH } from "@/lib/shell/consolePaths";

// `/console` has no content of its own; Settings is the only screen, so land there.
export default function ConsoleIndex() {
  redirect(CONSOLE_SETTINGS_PATH);
}
