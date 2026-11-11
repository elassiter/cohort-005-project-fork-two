# A Refund is always the amount paid, and is not stored

A Refund always returns exactly what the learner paid for the Purchase, so the Refund Request does not store a refund amount; it is read from the Purchase. We removed the old `amountRefunded` column, which was computed from today's price and country discount and could disagree with what was actually paid. Partial refunds are deliberately not supported; adding them later would need a stored amount and a decision about historical requests.
