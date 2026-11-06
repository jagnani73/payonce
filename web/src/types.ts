// The page's one door to the server's view contract. Every page module imports
// the view types from here, never from src/ directly, and only types cross it:
// the build refuses any page file that would bundle code from src/.
export type * from "../../src/views/contract.js";
