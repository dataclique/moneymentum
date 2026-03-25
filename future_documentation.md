currentPortfolio: Exact snapshot from the exchange (ReadOnly for UI).

targetPortfolio: User draft. Contains only the positions the user wants to see
at the end.

deletedArchive: "Trash" buffer. Stores the position state (its notional and
leverage) at the moment the user clicks "Delete". Needed for a correct Undo.
