'use strict';
// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cohesive error types shared across the OINK control-plane modules.
//
// - InputError: a client-supplied value is invalid → surfaced as a 400.
// - BusyError:  an operation is rejected because outputs are active / a queue
//   is full → surfaced as a 409 / 503 by the HTTP layer.

class InputError extends Error {}

class BusyError extends Error {}

module.exports = { InputError, BusyError };
