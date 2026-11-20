// SPDX-FileCopyrightText: Copyright 2026 Ayobami Haastrup
//
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial

import { useAuthStore } from "@/stores/auth";
import { fetch } from "@/utils/fetch";

/** Handle rejected credentials before API-specific error decoding loses the status. */
export const authenticatedFetch: typeof globalThis.fetch = async (
  request,
  init,
) => {
  const credentials = useAuthStore.getState().credentials;
  const headers = new Headers(
    init?.headers ?? (request instanceof Request ? request.headers : undefined),
  );
  const response = await fetch(request, init);

  // Discovery requests have no bearer token. A response for an old session
  // must not clear credentials installed by a later sign-in or token refresh.
  if (
    response.status === 401 &&
    credentials &&
    headers.get("Authorization") === `Bearer ${credentials.accessToken}` &&
    useAuthStore.getState().credentials === credentials
  ) {
    await useAuthStore.getState().clear(true);
  }

  return response;
};
