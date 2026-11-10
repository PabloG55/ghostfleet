import os from 'node:os';
import path from 'node:path';

// Where the installed ghostfleet lives — the runtime `install.sh` stages, not a clone.
export const GF_HOME = process.env.GHOSTFLEET_HOME || path.join(os.homedir(), '.local', 'libexec', 'ghostfleet');
