// SPDX-FileCopyrightText: 2026 OpenIRLNodeKit contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Card, Field, Input, Toggle } from './index';

describe('UI primitives', () => {
  it('renders a Button with variant classes', () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('bg-danger');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('renders a Card with title and description', () => {
    render(<Card title="Settings">content</Card>);
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('renders an Input and forwards props', () => {
    render(<Input placeholder="hello" aria-label="name" />);
    expect(screen.getByLabelText('name')).toHaveAttribute(
      'placeholder',
      'hello',
    );
  });

  it('renders a read-only copy of a value in Field', () => {
    render(
      <Field label="Threshold" htmlFor="th" error="too low">
        <Input id="th" defaultValue="900" />
      </Field>,
    );
    expect(screen.getByLabelText('Threshold')).toHaveValue('900');
    expect(screen.getByRole('alert')).toHaveTextContent('too low');
  });

  it('renders a Toggle with label and description', () => {
    render(
      <Toggle
        name="x"
        label="Enable"
        description="Switch it"
        checked={false}
        onChange={() => {}}
      />,
    );
    const toggle = screen.getByRole('checkbox');
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Enable')).toBeInTheDocument();
    expect(screen.getByText('Switch it')).toBeInTheDocument();
  });

  it('renders a Badge with a tone class', () => {
    render(<Badge tone="success">Live</Badge>);
    expect(screen.getByText('Live')).toHaveClass('text-success');
  });
});
