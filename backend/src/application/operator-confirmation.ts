import type { ComputerAction } from '../tools/computer-use.js';

export interface OperatorConfirmation {
  confirm(action: ComputerAction): Promise<boolean>;
  close(): Promise<void>;
}
