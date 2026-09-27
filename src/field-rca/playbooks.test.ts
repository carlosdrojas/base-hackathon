import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROOT_CAUSE_CLASSES } from "./contracts.js";
import { PLAYBOOK_IDS, loadPlaybooks, playbookForClass } from "./playbooks.js";

describe("authored playbooks", () => {
  it("has one versioned file per class and no extra ids", () => {
    const books = loadPlaybooks();
    assert.deepEqual(
      books.map((book) => book.id).sort(),
      [...PLAYBOOK_IDS].sort(),
    );
    for (const rootCause of ROOT_CAUSE_CLASSES) {
      const book = playbookForClass(rootCause);
      assert.equal(book.version, 1);
      assert.ok(book.checklist.length > 0);
    }
  });

  it("keeps the reseat procedure and its default action", () => {
    const book = playbookForClass("can_link_unreliable");
    assert.equal(book.id, "reseat_j3_can_capture_counters");
    assert.equal(book.max_level, "L4");
    assert.equal(book.action, "dispatch_technician");
    assert.deepEqual(book.photos_required, ["connector_seating", "harness_strain"]);
    assert.deepEqual(book.alerts, ["tech", "ops"]);
    assert.deepEqual(book.checklist, [
      "Capture CAN error counters before touch",
      "Reseat J3 until latch clicks",
      "Recapture counters; bus-off must be 0",
      "Do not pull inverter if counters clear",
    ]);
  });
});
