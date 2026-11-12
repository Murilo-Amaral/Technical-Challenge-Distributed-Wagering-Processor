import { CreateSharedFunctions1761000000000 } from "./1761000000000-CreateSharedFunctions";
import { CreateWallets1761000000001 } from "./1761000000001-CreateWallets";
import { CreateWagerTransactions1761000000002 } from "./1761000000002-CreateWagerTransactions";
import { CreateLedger1761000000003 } from "./1761000000003-CreateLedger";
import { CreateInboxOutbox1761000000004 } from "./1761000000004-CreateInboxOutbox";

/** Explicit, ordered list (no filesystem globbing: works the same under Bun, in tests and in containers). */
export const migrations = [
  CreateSharedFunctions1761000000000,
  CreateWallets1761000000001,
  CreateWagerTransactions1761000000002,
  CreateLedger1761000000003,
  CreateInboxOutbox1761000000004,
];
