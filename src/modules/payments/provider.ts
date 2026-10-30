export type ChargeOutcome = 'succeeded' | 'pending' | 'declined' | 'failed';

export interface PaymentProvider {
  charge(input: { amountCents: number; method: string; outcomeHint?: ChargeOutcome }): Promise<{ status: ChargeOutcome }>;
  confirm(input: { amountCents: number }): Promise<{ status: 'succeeded' | 'failed' }>;
}

// Stand-in for a real provider such as Stripe. Nothing is charged.
// The outcome can be chosen by the caller (when allowed) so every payment state can be demonstrated.
export class SimulatedProvider implements PaymentProvider {
  constructor(private allowHints: boolean) {}

  async charge(input: { amountCents: number; method: string; outcomeHint?: ChargeOutcome }) {
    return { status: this.allowHints && input.outcomeHint ? input.outcomeHint : ('succeeded' as ChargeOutcome) };
  }

  async confirm() {
    return { status: 'succeeded' as const };
  }
}
