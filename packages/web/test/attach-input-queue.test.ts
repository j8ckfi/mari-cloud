import { decodeCbor } from '@mari/shared';
import type { ClientToDo } from '@mari/shared';
import { describe, expect, it } from 'vitest';
import { AttachClient, type SocketLike } from '../src/ws/attach';

class StrictSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  sent: ClientToDo[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== 1) {
      throw new DOMException('WebSocket is still connecting', 'InvalidStateError');
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(decodeCbor(bytes) as ClientToDo);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  fail(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function inputBytes(messages: ClientToDo[]): number[] {
  return messages
    .filter((message): message is Extract<ClientToDo, { t: 'input' }> => message.t === 'input')
    .flatMap((message) => Array.from(message.bytes));
}

describe('AttachClient disconnected-input queue', () => {
  it('copies connecting input before retaining and flushing it', () => {
    const socket = new StrictSocket();
    const client = new AttachClient({
      url: 'ws://example/attach/c1',
      run: 'run-1',
      cols: 80,
      rows: 24,
      handlers: {},
      socketFactory: () => socket,
    });

    client.connect();
    const typed = new Uint8Array([1, 2, 3]);
    expect(() => client.input(typed)).not.toThrow();
    typed.fill(9);
    socket.open();

    expect(socket.sent.map((message) => message.t)).toEqual(['attach', 'input']);
    expect(inputBytes(socket.sent)).toEqual([1, 2, 3]);
    client.close();
  });

  it('bounds reconnect input and flushes only the newest bytes after attach', () => {
    const sockets: StrictSocket[] = [];
    let reconnect: (() => void) | null = null;
    const client = new AttachClient({
      url: 'ws://example/attach/c1',
      run: 'run-1',
      cols: 80,
      rows: 24,
      handlers: {},
      maxQueuedInputBytes: 4,
      socketFactory: () => {
        const socket = new StrictSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: (fn) => {
        reconnect = fn;
        return 1;
      },
      clearTimeoutFn: () => {},
    });

    client.connect();
    sockets[0]!.open();
    sockets[0]!.fail();
    client.input(new Uint8Array([1, 2, 3]));
    client.input(new Uint8Array([4, 5, 6]));

    expect(reconnect).not.toBeNull();
    (reconnect as () => void)();
    sockets[1]!.open();

    expect(sockets[1]!.sent[0]?.t).toBe('attach');
    expect(inputBytes(sockets[1]!.sent)).toEqual([3, 4, 5, 6]);
    client.close();
  });
});
