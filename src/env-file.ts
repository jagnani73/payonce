// Loads .env from the working directory when there is one, as every command
// does, and says nothing when there is none: a command that needs a setting then
// names it in PayOnce's words. A variable already set in the environment keeps
// its value. The scripts do not use node's --env-file flags, because --env-file
// stops on a missing file in node's words and --env-file-if-exists prints its
// note once for tsx and again for the script.
export function loadEnvIfPresent(): void {
  try {
    process.loadEnvFile(".env");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
