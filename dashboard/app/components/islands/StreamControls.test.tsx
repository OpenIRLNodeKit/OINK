// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import type { RecordStatus, StreamStatus } from '../../lib/types';
import StreamControls from './StreamControls';

vi.mock('../../lib/api', () => ({
  getObsStreamStatus: vi.fn(),
  getObsRecordStatus: vi.fn(),
  startObsStream: vi.fn(),
  stopObsStream: vi.fn(),
  startObsRecord: vi.fn(),
  stopObsRecord: vi.fn(),
}));

const mockedStreamStatus = vi.mocked(api.getObsStreamStatus);
const mockedRecordStatus = vi.mocked(api.getObsRecordStatus);
const mockedStartStream = vi.mocked(api.startObsStream);
const mockedStopStream = vi.mocked(api.stopObsStream);
const mockedStartRecord = vi.mocked(api.startObsRecord);
const mockedStopRecord = vi.mocked(api.stopObsRecord);

function stream(active: boolean): StreamStatus {
  return {
    outputActive: active,
    outputTimecode: active ? '00:01:00.000' : '',
    outputDuration: active ? 60000 : 0,
    outputBytes: active ? 1048576 : 0,
    outputSkippedFrames: 0,
    outputTotalFrames: 0,
  };
}

function record(active: boolean): RecordStatus {
  return {
    outputActive: active,
    outputTimecode: active ? '00:00:30.000' : '',
    outputDuration: active ? 30000 : 0,
    outputBytes: active ? 524288 : 0,
    outputPaused: false,
  };
}

describe('StreamControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStreamStatus.mockResolvedValue(stream(false));
    mockedRecordStatus.mockResolvedValue(record(false));
  });

  it('renders both toggles in their start state when idle', async () => {
    render(<StreamControls />);

    const startStream = await screen.findByRole('button', {
      name: 'Start Stream',
    });
    const startRecord = screen.getByRole('button', { name: 'Start Recording' });
    expect(startStream).toHaveAttribute('aria-pressed', 'false');
    expect(startRecord).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });

  it('shows a recording caption without a leading separator when only recording', async () => {
    mockedRecordStatus.mockResolvedValue(record(true));
    render(<StreamControls />);

    await screen.findByRole('button', { name: 'Stop Recording' });
    expect(screen.getByText(/^REC · /)).toBeInTheDocument();
    expect(screen.queryByText(/Offline/)).not.toBeInTheDocument();
  });

  it('flips the stream toggle to stop when streaming is active', async () => {
    mockedStreamStatus.mockResolvedValue(stream(true));
    render(<StreamControls />);

    const stopStream = await screen.findByRole('button', {
      name: 'Stop Stream',
    });
    expect(stopStream).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Start Recording' }),
    ).toBeInTheDocument();
  });

  it('flips the record toggle to stop when recording is active', async () => {
    mockedRecordStatus.mockResolvedValue(record(true));
    render(<StreamControls />);

    const stopRecord = await screen.findByRole('button', {
      name: 'Stop Recording',
    });
    expect(stopRecord).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Start Stream' }),
    ).toBeInTheDocument();
  });

  it('starts the stream when the idle stream toggle is clicked', async () => {
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Start Stream' }),
    );
    await waitFor(() => expect(mockedStartStream).toHaveBeenCalledTimes(1));
    expect(mockedStopStream).not.toHaveBeenCalled();
  });

  it('stops the stream when the active stream toggle is clicked', async () => {
    mockedStreamStatus.mockResolvedValue(stream(true));
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Stop Stream' }),
    );
    await waitFor(() => expect(mockedStopStream).toHaveBeenCalledTimes(1));
    expect(mockedStartStream).not.toHaveBeenCalled();
  });

  it('starts recording when the idle record toggle is clicked', async () => {
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Start Recording' }),
    );
    await waitFor(() => expect(mockedStartRecord).toHaveBeenCalledTimes(1));
    expect(mockedStartStream).not.toHaveBeenCalled();
  });

  it('stops recording when the active record toggle is clicked', async () => {
    mockedRecordStatus.mockResolvedValue(record(true));
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Stop Recording' }),
    );
    await waitFor(() => expect(mockedStopRecord).toHaveBeenCalledTimes(1));
  });

  it('disables both toggles when status is unavailable', async () => {
    mockedStreamStatus.mockRejectedValue(new Error('obs down'));
    mockedRecordStatus.mockRejectedValue(new Error('obs down'));
    render(<StreamControls />);

    await waitFor(() =>
      expect(screen.getByText('OBS unreachable')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Start Stream' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Start Recording' }),
    ).toBeDisabled();
  });

  it('flips the toggle optimistically without waiting for the next poll', async () => {
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Start Recording' }),
    );
    // status mock stays inactive; the button must still flip on the click.
    expect(
      await screen.findByRole('button', { name: 'Stop Recording' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('surfaces an error when a toggle action fails', async () => {
    mockedStartRecord.mockRejectedValue(new Error('disk full'));
    const user = userEvent.setup();
    render(<StreamControls />);

    await user.click(
      await screen.findByRole('button', { name: 'Start Recording' }),
    );
    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });
});
