import type { ComputerAction, ComputerResult, ComputerUseService } from '../tools/computer-use.js';
import type { OperatorConfirmation } from './operator-confirmation.js';
import { badRequest, conflict, unavailable } from '../shared/app-error.js';

export class ComputerControlService {
  constructor(private readonly computer: Pick<ComputerUseService, 'perform' | 'isAvailable'>, private readonly confirmation: OperatorConfirmation) {}

  isAvailable(): boolean { return this.computer.isAvailable(); }

  async execute(action: ComputerAction): Promise<ComputerResult> {
    if (!action?.kind) throw badRequest('action is required');
    if (!this.isAvailable()) throw unavailable('computer use is not available');
    if (action.kind !== 'screenshot' && !await this.confirmation.confirm(action)) throw conflict('computer action was not approved');
    return this.computer.perform(action);
  }
}
