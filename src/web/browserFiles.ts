import type { FileTransfer } from "../core/platform";

export const browserFiles: FileTransfer = {
  async saveJson(suggestedName, contents) {
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  },

  openJson() {
    return new Promise<string | null>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("cancel", () => resolve(null));
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        file.text().then(resolve, reject);
      });
      input.click();
    });
  },
};
