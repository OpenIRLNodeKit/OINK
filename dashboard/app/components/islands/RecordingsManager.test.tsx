// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecordingsManager from './RecordingsManager';
import * as api from '../../lib/api';

vi.mock('../../lib/api', () => ({
  listRecordings: vi.fn(),
  deleteRecording: vi.fn(),
  recordingUrl: (name: string) => `/api/recordings/${encodeURIComponent(name)}`,
  recordingDownloadUrl: (name: string) =>
    `/api/recordings/${encodeURIComponent(name)}?download=1`,
  recordingThumbUrl: (name: string) =>
    `/api/recordings/${encodeURIComponent(name)}/thumb.jpg`,
}));

const mockedList = vi.mocked(api.listRecordings);
const mockedDelete = vi.mocked(api.deleteRecording);

function rec(name: string, overrides: Partial<api.RecordingFile> = {}) {
  return { name, size: 1024, mtime: 1700000000000, hasThumb: false, ...overrides };
}

describe('RecordingsManager', () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedDelete.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the recordings grid after loading', async () => {
    mockedList.mockResolvedValue([rec('2026-09-01 21-54-24.mp4')]);
    render(<RecordingsManager />);

    expect(await screen.findByText('2026-09-01 21-54-24.mp4')).toBeInTheDocument();
    expect(screen.getByTestId('recording-count')).toHaveTextContent(
      '1 recording on this server',
    );
    expect(screen.getByTestId('recording-thumb')).toHaveAttribute(
      'src',
      '/api/recordings/2026-09-01%2021-54-24.mp4/thumb.jpg',
    );
  });

  it('shows a loading message before the first fetch resolves', () => {
    mockedList.mockReturnValue(new Promise(() => {}));
    render(<RecordingsManager />);
    expect(screen.getByText('Loading recordings…')).toBeInTheDocument();
  });

  it('renders an empty state when there are no recordings', async () => {
    mockedList.mockResolvedValue([]);
    render(<RecordingsManager />);
    expect(
      await screen.findByText(/No recordings yet/),
    ).toBeInTheDocument();
  });

  it('shows an error when listing fails', async () => {
    mockedList.mockRejectedValue(new Error('disk full'));
    render(<RecordingsManager />);
    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('disk full');
  });

  it('opens a player modal when a recording is clicked', async () => {
    mockedList.mockResolvedValue([rec('clip.mp4')]);
    const user = userEvent.setup();
    render(<RecordingsManager />);

    await user.click(await screen.findByRole('button', { name: 'Play clip.mp4' }));
    expect(screen.getByTestId('recording-player')).toBeInTheDocument();
    expect(screen.getByTestId('recording-video')).toHaveAttribute(
      'src',
      '/api/recordings/clip.mp4',
    );
    await user.click(screen.getByRole('button', { name: 'Close player' }));
    await waitFor(() =>
      expect(screen.queryByTestId('recording-player')).not.toBeInTheDocument(),
    );
  });

  it('deletes a recording after confirmation and removes it from the grid', async () => {
    mockedList.mockResolvedValue([rec('clip.mp4'), rec('other.mp4')]);
    mockedDelete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RecordingsManager />);

    await user.click(await screen.findByRole('button', { name: 'Delete clip.mp4' }));
    expect(window.confirm).toHaveBeenCalledWith('Delete "clip.mp4"?');
    expect(mockedDelete).toHaveBeenCalledWith('clip.mp4');
    await waitFor(() =>
      expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('other.mp4')).toBeInTheDocument();
  });

  it('does not delete when the confirmation is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockedList.mockResolvedValue([rec('clip.mp4')]);
    const user = userEvent.setup();
    render(<RecordingsManager />);

    await user.click(await screen.findByRole('button', { name: 'Delete clip.mp4' }));
    expect(mockedDelete).not.toHaveBeenCalled();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('surfaces a delete error as a status message', async () => {
    mockedList.mockResolvedValue([rec('clip.mp4')]);
    mockedDelete.mockRejectedValue(new Error('permission denied'));
    const user = userEvent.setup();
    render(<RecordingsManager />);

    await user.click(await screen.findByRole('button', { name: 'Delete clip.mp4' }));
    expect(
      await screen.findByText(/Failed to delete clip.mp4: permission denied/),
    ).toBeInTheDocument();
  });
});
