// SPDX-FileCopyrightText: Copyright 2026 Ayobami Haastrup
//
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial

import { http, HttpResponse } from "msw";

import { heading } from "../helpers";
import { loginAs } from "../mocks/auth";
import { masFailing, masFailingPost, matrixFailing } from "../mocks/failing";
import {
  DEFAULT_PERSONAL_SESSIONS,
  personalSessionId,
  SERVER_NAME,
} from "../mocks/fixtures";
import { expect, test } from "../mocks/test";

const expiredMessage = "Your session is no longer valid. Please sign in again.";

test.describe("rejected sessions", () => {
  for (const api of ["matrix", "mas"] as const) {
    test(`signs out on a ${api} 401 even with cached console data`, async ({
      page,
      network,
    }) => {
      await loginAs(page);
      await page.goto("/users");
      await expect(page.getByRole("heading", heading("Users"))).toBeVisible();

      network.use(
        api === "matrix"
          ? matrixFailing("/_matrix/client/v3/account/whoami", 401)
          : masFailing("/api/admin/v1/users", 401),
      );
      await page.reload();

      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("status")).toHaveText(expiredMessage);
      await expect(page.getByRole("grid")).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(localStorage.getItem("auth") ?? "null").state
                .credentials,
          ),
        )
        .toBeNull();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              new Promise<string[]>((resolve, reject) => {
                const open = indexedDB.open("keyval-store");
                open.addEventListener("error", () => reject(open.error));
                open.addEventListener("success", () => {
                  const db = open.result;
                  const transaction = db.transaction("keyval", "readonly");
                  const keys = transaction.objectStore("keyval").getAllKeys();
                  keys.addEventListener("success", () =>
                    resolve(
                      keys.result
                        .map(String)
                        .filter((key) => key.startsWith("tanstack-query")),
                    ),
                  );
                  keys.addEventListener("error", () => reject(keys.error));
                  transaction.addEventListener("complete", () => db.close());
                });
              }),
          ),
        )
        .toEqual([]);
      await page.reload();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("grid")).toBeHidden();
    });
  }

  for (const status of [403, 500]) {
    test(`keeps the session on HTTP ${status}`, async ({ page, network }) => {
      await loginAs(page);
      network.use(masFailing("/api/admin/v1/users", status));
      await page.goto("/users");
      await expect(
        page.getByRole("heading", heading("An unexpected error occurred")),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("auth") ?? "null").state
              .credentials,
        ),
      ).not.toBeNull();
      await expect(page.getByText(expiredMessage)).toBeHidden();
    });
  }

  test("keeps the session after a network failure", async ({
    page,
    network,
  }) => {
    await loginAs(page);
    network.use(http.get("*/api/admin/v1/users", () => HttpResponse.error()));
    await page.goto("/users");
    await expect(
      page.getByRole("heading", heading("An unexpected error occurred")),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("auth") ?? "null").state.credentials,
      ),
    ).not.toBeNull();
  });

  test("does not sign out on an unauthenticated discovery 401", async ({
    page,
    network,
  }) => {
    await loginAs(page);
    network.use(matrixFailing("/_matrix/client/v1/auth_metadata", 401));
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/_matrix/client/v1/auth_metadata") &&
        r.status() === 401,
    );
    await page.goto("/");
    await response;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("auth") ?? "null").state
              .credentials,
        ),
      )
      .not.toBeNull();
    await expect(page.getByText(expiredMessage)).toBeHidden();
  });

  test("signs out when an authenticated mutation is rejected", async ({
    page,
    network,
  }) => {
    await loginAs(page);
    await page.goto(
      `/personal-tokens/${personalSessionId(DEFAULT_PERSONAL_SESSIONS, 0)}`,
    );
    network.use(
      masFailingPost("/api/admin/v1/personal-sessions/:id/revoke", 401),
    );
    await page.getByRole("button", { name: "Revoke token" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke token" })
      .click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("status")).toHaveText(expiredMessage);
  });

  test("an old request cannot sign out replacement credentials", async ({
    page,
  }) => {
    await loginAs(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route("**/api/admin/v1/users?*", async (route) => {
      started();
      await gate;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await requested;
    await page.evaluate(
      ({ serverName }) => {
        const hook = (globalThis as unknown as Record<string, unknown>)[
          "__useStaticCredentials"
        ];
        (hook as (server: string, token: string) => void)(
          serverName,
          "replacement-token",
        );
      },
      { serverName: SERVER_NAME },
    );
    const response = page.waitForResponse(
      (r) => r.url().includes("/api/admin/v1/users") && r.status() === 401,
    );
    release();
    await response;
    await expect(
      page.getByRole("heading", heading("An unexpected error occurred")),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("auth") ?? "null").state.credentials
            .accessToken,
      ),
    ).toBe("replacement-token");
  });
});
