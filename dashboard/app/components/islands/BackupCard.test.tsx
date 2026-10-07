// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../lib/api';
import BackupCard from './BackupCard';

vi.mock('../../lib/api', () => ({
  getBackupSize: vi.fn(),
  backupDownloadUrl: vi.fn(() => '/api/backup?assets=0&recordings=0'),
  restoreBackup: vi.fn(),
}));

const channelMock = vi.hoisted(() => ({ value: '' }));

vi.mock('../../lib/useChannel', () => ({
  useChannel: () => ({
    channel: channelMock.value,
    setChannel: vi.fn(),
    loading: false,
    error: null,
  }),
}));

const mockedSize = vi.mocked(api.getBackupSize);
const mockedUrl = vi.mocked(api.backupDownloadUrl);
const mockedRestore = vi.mocked(api.restoreBackup);

describe('BackupCard', () => {
  beforeEach(() => {
    channelMock.value = '';
    mockedSize.mockReset().mockResolvedValue({ files: 12, bytes: 2048 });
    mockedUrl.mockReset().mockReturnValue('/api/backup?assets=0&recordings=0');
    mockedRestore.mockReset();
  });

  it('shows the size estimate and toggles opt in', async () => {
    const user = userEvent.setup();
    render(<BackupCard />);

    expect(await screen.findByText(/12 files/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Include uploaded assets'));
    await waitFor(() =>
      expect(mockedSize).toHaveBeenLastCalledWith(true, false),
    );
  });

  it('links the download to the selected options', async () => {
    const user = userEvent.setup();
    render(<BackupCard />);

    await user.click(screen.getByLabelText('Include recordings'));
    expect(mockedUrl).toHaveBeenLastCalledWith(false, true, '');
    expect(screen.getByText('Download backup').closest('a')).toHaveAttribute(
      'href',
      '/api/backup?assets=0&recordings=0',
    );
  });

  it('uses the saved channel name in the download filename', async () => {
    channelMock.value = 'my-channel';
    render(<BackupCard />);
    await waitFor(() =>
      expect(mockedUrl).toHaveBeenLastCalledWith(false, false, 'my-channel'),
    );
  });

  it('restores an uploaded archive and reports the outcome', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedRestore.mockResolvedValue({
      restored: ['stack/users.json'],
      skipped: ['stack/api.env'],
      failed: [],
      restarted: ['oink-obs'],
      note: 'api.env skipped',
    });
    const user = userEvent.setup();
    const { container } = render(<BackupCard />);

    const file = new File(['x'], 'oink-backup.zip', {
      type: 'application/gzip',
    });
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      file,
    );

    await waitFor(() => expect(mockedRestore).toHaveBeenCalledWith(file));
    expect(await screen.findByText(/1 files restored/)).toBeInTheDocument();
    expect(screen.getByText(/restarted oink-obs/)).toBeInTheDocument();
  });

  it('shows an error when restore fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedRestore.mockRejectedValue(
      new Error('checksum mismatch: stack/users.json'),
    );
    const user = userEvent.setup();
    const { container } = render(<BackupCard />);

    const file = new File(['x'], 'bad.zip', { type: 'application/gzip' });
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      file,
    );

    expect(await screen.findByText(/checksum mismatch/)).toBeInTheDocument();
  });
});
