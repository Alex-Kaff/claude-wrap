// Quoting for cmd.exe command lines (Windows windowed-launch paths).

/** Quote a single argv element for a cmd.exe command line.
 *
 * cmd.exe expands %VAR% sequences during its own argument parsing
 * *before* quote processing, so double-quotes alone won't protect a
 * path containing a literal percent sign. We double every `%` to
 * suppress expansion, then wrap in quotes and escape embedded `"`.
 */
export function quoteCmdArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  const escaped = arg.replace(/%/g, "%%").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
