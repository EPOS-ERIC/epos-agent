## 15. Cosa non è ancora implementato

Il progetto non deve essere descritto come completo oltre ciò che esiste. In
particolare, restano fuori dalla fase corrente:

- endpoint EPOS adiacenti per metadata più ricchi;
- fetch controllato di URL arbitrari;
- supporto operativo OGC, ispezione e visualizzazione specialistica;
- bundle riproducibile che raccolga automaticamente dataset, README, script e
  provenance;
- pre-analisi standardizzata (struttura, completezza, missing values, anomalie);
- template deterministici per grafici, mappe e notebook;
- verifica end-to-end su più provider/modelli.

La dimensione della risposta grezza ricevuta dal server EPOS resta fuori scope:
l'MCP la deve comunque leggere per poter fare flattening e ranking; l'obiettivo
attuato è non trasferirla tutta al modello.
## 16. Come orientarsi durante la manutenzione

Per una modifica alla conversazione, iniziare da `prompts/SYSTEM.md` e dalla
skill più specifica. Per una modifica alla disponibilità dei tool, guardare
`TOOL_GROUPS` e `createLoadToolsTool` nell'estensione. Per cambiare endpoint,
schema o trasformazione EPOS, modificare `services/mcp-epos/tools/epos_mcp_http.py` e
confrontare l'OpenAPI locale. Per cambiare il ciclo di avvio o l'isolamento del
contesto, intervenire nel launcher.

Un'estensione nuova dovrebbe seguire questa regola pratica:

1. aggiungere il tool MCP solo se è una capacità tecnica riusabile;
2. aggiungere un wrapper Pi se occorrono router, provenance, stato o limiti
   di contesto;
3. assegnarlo a un gruppo `TOOL_GROUPS` il più stretto possibile;
4. aggiornare la skill soltanto se cambia la decisione che il modello deve fare;
5. tenere le risposte inviate al modello piccole e salvare i dati completi nel
   workspace;
6. verificare prima il contratto MCP e poi una query reale rappresentativa.

Questa disciplina mantiene separati i tre livelli fondamentali: *policy* nelle
skill, *orchestrazione* nell'estensione e *fatti/azioni tecniche* nei server MCP.
