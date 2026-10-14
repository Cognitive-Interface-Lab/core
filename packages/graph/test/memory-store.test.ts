import { MemoryGraphStore } from "@core/graph";
import { describeGraphStoreContract } from "@core/graph/testing";

describeGraphStoreContract("MemoryGraphStore", async () => ({ store: new MemoryGraphStore() }));
