// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("options main.jsx", () => {
  let sendMessageMock;
  let confirmMock;
  let alertMock;

  beforeEach(() => {
    vi.resetModules();

    const rootEl = document.createElement("div");
    rootEl.id = "options-root";
    document.body.appendChild(rootEl);

    sendMessageMock = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: sendMessageMock,
      },
    });

    confirmMock = vi.fn(() => true);
    alertMock = vi.fn();
    vi.stubGlobal("confirm", confirmMock);
    vi.stubGlobal("alert", alertMock);
  });

  afterEach(() => {
    const rootEl = document.getElementById("options-root");
    if (rootEl) rootEl.remove();
    vi.unstubAllGlobals();
  });

  it("renders loading state then list of records", async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === "listRecords") {
        cb({
          ok: true,
          items: [
            {
              key: "rec1",
              sourceUrl: "https://example.com",
              createdAt: 1716972000000,
              status: "done",
            },
          ],
        });
      }
    });

    await import("./main.jsx");

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "listRecords" },
      expect.any(Function)
    );

    const table = document.querySelector("table");
    expect(table).not.toBeNull();

    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("https://example.com");
    expect(rows[0].textContent).toContain("done");

    const openBtn = rows[0].querySelectorAll("button")[0];
    openBtn.click();
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("re-picking"));

    const reprocessBtn = rows[0].querySelectorAll("button")[1];
    reprocessBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Reprocess"));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "reprocessRecord", key: "rec1" },
      expect.any(Function)
    );

    const deleteBtn = rows[0].querySelectorAll("button")[2];
    deleteBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Delete this record"));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "deleteRecord", key: "rec1" },
      expect.any(Function)
    );
  });

  it("handles empty record list", async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === "listRecords") {
        cb({ ok: true, items: [] });
      }
    });

    await import("./main.jsx");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const empty = document.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("No records yet");
  });

  it("handles deleteAll", async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === "listRecords") {
        cb({
          ok: true,
          items: [
            {
              key: "rec1",
              sourceUrl: "https://example.com",
              createdAt: 1716972000000,
              status: "done",
            },
          ],
        });
      } else if (msg.type === "deleteAll") {
        cb({ ok: true });
      }
    });

    await import("./main.jsx");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deleteAllBtn = document.querySelector(".danger");
    expect(deleteAllBtn).not.toBeNull();

    deleteAllBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Delete ALL records"));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "deleteAll" },
      expect.any(Function)
    );
  });
});
