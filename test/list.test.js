import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { List } from '../src/components/List.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const items = ['first', 'second', 'third'];
const renderItem = (item, active) => <Text key={item}>{`${active ? '>' : ' '}${item}`}</Text>;

describe('List small viewports', () => {
  it('keeps one item navigable when height is zero and can hide the position row', async () => {
    const onSelect = vi.fn();
    const view = render(<List items={items} height={0} showPosition={false} onSelect={onSelect} renderItem={renderItem} />);
    await sleep(25);
    expect(view.lastFrame()).toBe('>first');
    view.stdin.write('\x1b[6~');
    await sleep(25);
    expect(view.lastFrame()).toBe('>second');
    view.stdin.write('\r');
    await sleep(25);
    expect(onSelect).toHaveBeenCalledWith('second', 1);
    view.unmount();
  });

  it('retains the default position indicator', async () => {
    const view = render(<List items={items} height={1} renderItem={renderItem} />);
    await sleep(25);
    expect(view.lastFrame()).toContain('1/3');
    view.unmount();
  });
});
