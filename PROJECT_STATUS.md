# EPOS Agent — requisiti, stato e roadmap

## Obiettivo del progetto

EPOS Agent deve essere un assistente operativo per accedere ai servizi della European Plate Observing System. Deve aiutare il ricercatore nelle attività ripetitive di discovery, scelta del servizio, validazione dei parametri, download, provenance e preparazione di codice iniziale revisionabile.

L'agente non deve presentarsi come sostituto del ricercatore: dati recuperati, trasformazioni automatiche, interpretazioni e decisioni scientifiche devono rimanere chiaramente distinti.

## Abitudini ed esigenze del ricercatore

Il comportamento dell'agente deve tenere conto delle seguenti esigenze:

1. **Trasparenza del processo.** Il ricercatore vuole sapere cosa sta accadendo. Prima e dopo ogni operazione rilevante, l'agente deve indicare in modo breve l'azione, il motivo, la fonte utilizzata, i parametri principali e il risultato ottenuto.
2. **Guida passo passo.** L'agente deve accompagnare il ricercatore anche dopo il primo risultato, spiegando il prossimo passo utile e attendendo una scelta quando esistono decisioni scientifiche o operative significative.
3. **Opzioni complete ma incrementali.** Il ricercatore deve poter conoscere tutte le alternative disponibili senza riceverle tutte insieme. L'agente mostra tutti i risultati della pagina corrente, dichiara quante altre opzioni esistono e recupera le successive soltanto quando l'utente lo richiede.
4. **Workflow riconoscibile.** Il percorso predefinito deve essere: ricerca dei dati → selezione e download → pre-analisi → codice e/o visualizzazione.
5. **Raffinamento collaborativo.** Il modello deve fare domande mirate quando mancano dettagli utili, per esempio dominio, area, intervallo temporale, risoluzione, formato, variabili o soglie scientifiche. Non deve inventare i valori mancanti.
6. **Preventivo prima del download.** Prima di scaricare, l'agente deve mostrare quando possibile numero stimato di record, dimensione prevista, formato, intervallo, area, servizio e provider. Deve distinguere una stima da un valore certo e segnalare quando il servizio non consente di calcolarla in anticipo.
7. **Prima valutazione dei dati.** Dopo il download, l'agente deve proporre una validazione o visualizzazione preliminare: struttura, completezza, valori mancanti, intervalli, anomalie evidenti e idoneità rispetto alla richiesta. Questa fase non equivale a una validazione scientifica definitiva.
8. **Controllo al ricercatore.** L'agente può trovare servizi, scaricare dati e preparare una prima analisi, ma deve lasciare al ricercatore la scelta tra approfondimento descrittivo, codice riproducibile, visualizzazione o analisi successiva.

## Requisiti raccolti

I requisiti espressi all'inizio del progetto e durante la definizione della v0.2 sono:

1. Ridurre drasticamente il consumo di token e la verbosità.
2. Evitare di caricare nel contesto l'intero catalogo EPOS, metadata raw, facet e schemi di tool non necessari.
3. Usare progressive disclosure: mostrare pochi risultati essenziali e caricare i dettagli solo quando servono.
4. Non usare una modalità “caveman”: le risposte devono essere compatte, leggibili e scientificamente precise.
5. Non legare il progetto a GPT-5.5, OpenAI o a un meccanismo proprietario di deferred loading.
6. Supportare qualsiasi provider e modello configurabile in Pi che disponga di tool calling.
7. Fare in modo che sia l'agente a scegliere e caricare automaticamente i tool necessari, senza intervento manuale dell'utente.
8. Avviare i server MCP solo quando vengono realmente utilizzati.
9. Usare contratti MCP standard, schemi tipizzati e `structuredContent`.
10. Limitare a 3–5 le alternative del catalogo mostrate in chat, senza limitare i record scientifici richiesti.
11. Se vengono richiesti tutti i terremoti di un mese, scaricare tutti e soli gli eventi che rispettano l'intervallo e gli altri filtri.
12. Conservare il dataset completo nel workspace e mostrare in chat solo una sintesi e pochi esempi.
13. Rispettare un limite numerico soltanto quando viene richiesto esplicitamente dall'utente.
14. Dichiarare chiaramente i download incompleti e conservarli come file parziali, senza presentarli come dataset completi.
15. Usare una sola conferma per il piano di download e un limite cumulativo di 1 GiB per studio.
16. Registrare metriche sui token senza salvare prompt o dati scientifici nel log di utilizzo.
17. Rendere l'accesso ai servizi EPOS più guidato e rassicurante per utenti non esperti.
18. Introdurre workflow semplici: trova dati, descrivi servizio, scarica dati, genera codice, crea grafico, crea notebook e mostra provenance.
19. Mantenere uno stato conversazionale sintetico con intento, dominio, filtri, servizio selezionato, formato, file e provenance.
20. Produrre output riproducibili: dataset, `provenance.json`, parametri, script Python o notebook ed eventualmente un README.
21. Creare una skill e tool deterministici per grafici, mappe e analisi preliminari.
22. Introdurre una modalità demo passo passo, con conferme esplicite e spiegazioni brevi.
23. Preparare un caso dimostrativo riproducibile, inizialmente terremoti in Italia/Mediterraneo e successivamente un caso vulcanologico sull'Etna con layer cartografici.
24. Creare eventuali test, fixture e script di verifica solo in directory temporanee ed eliminarli al termine.
25. Integrare nell'MCP la skill `epos-api` ricevuta, adattandone il contratto OpenAPI, la ricerca delle organizzazioni, il supporto OGC e gli strumenti di ispezione/visualizzazione all'architettura model-agnostic esistente.
26. Rendere trasparente ogni fase mostrando azione corrente, fonte, parametri, stato e prossimo passo senza esporre dettagli tecnici non necessari.
27. Esaminare tutte le alternative disponibili e presentare in chat soltanto i titoli rilevanti raggruppati per funzione scientifica.
28. Applicare il workflow ricerca → download → pre-analisi → codice/visualizzazione e mantenere il ricercatore in controllo delle transizioni.
29. Fare domande mirate per completare i dettagli scientifici e operativi mancanti prima di scegliere o interrogare un servizio.
30. Fornire prima del download un preventivo dichiaratamente stimato di record e dimensione, quando tecnicamente disponibile.

## Stato dei requisiti

| Area | Stato | Nota |
|---|---|---|
| Riduzione di prompt, skill e schemi iniziali | Completato | Il contesto iniziale contiene solo i tool essenziali. |
| Risposte compatte e metadata filtrati | Completato | Gli output MCP escludono facet e payload raw non necessari. |
| Riepilogo obbligatorio in quattro sezioni | Rimosso | La provenance viene riportata solo quando pertinente. |
| Supporto provider/modello indipendente | Completato | Nessun default OpenAI o GPT-5.5; è richiesto il tool calling. |
| Caricamento automatico dei tool | Completato | `epos_load_tools` abilita gruppi di capacità su richiesta del modello. |
| Reset dei tool a ogni nuovo turno | Completato | Il turno successivo riparte dal set minimo. |
| Avvio lazy dei server MCP | Completato | EPOS e FDSN partono alla prima chiamata effettiva. |
| Contratti MCP tipizzati e `structuredContent` | Completato | Il server EPOS espone sette tool MCP v0.2. |
| Ricerca completa e sintesi compatta del catalogo | Completato | L'adapter percorre tutte le pagine; la chat raggruppa i soli titoli rilevanti. |
| Download EPOS nel bundle dello studio | Completato | Trasporto e completezza scientifica sono distinti; la chat riceve percorso, dimensione, formato, anteprima e provenance. |
| Download FDSN completo | Completato | Senza limite esplicito usa partizioni temporali, deduplicazione e verifica degli estremi. |
| File FDSN parziali in caso di errore | Completato | Il suffisso `.partial.jsonl` indica un dataset incompleto. |
| Conferma unica e budget di 1 GiB | Completato | Un piano complessivo viene confermato una volta; non esiste più la soglia separata di 50 MB. |
| Telemetria provider-neutral | Completato | Token, cache e costo sono registrati senza prompt o dati scientifici. |
| Workflow guidati per utenti non esperti | Completato | Stato e istruzioni seguono contesto, domanda, servizi, conferma, visualizzazione e codice/notebook. |
| Stato conversazionale sintetico | Completato | Lo stato v2 conserva studio, fase, piano, budget e artefatti ed è compatibile con lo stato v1. |
| Bundle riproducibile per studio | Completato | Ogni studio raccoglie dati, figure, provenance, parametri, script, notebook, manifest e README. |
| Generazione automatica di codice/notebook | Completato | Il bundle contiene `analysis.py` e un notebook che lo importa. |
| Skill deterministica per i plot | Completato | La selezione è basata su formato e struttura dei dati, senza località o layer hardcoded. |
| Integrazione della skill `epos-api` nell'MCP | Parziale | OpenAPI locale, ricerca organizzazioni e search token-efficient sono integrate; mancano metadata adiacenti, fetch controllato, inspect, visualize e workflow OGC. |
| Trasparenza delle operazioni | Parziale | Provenance e stato sono disponibili, ma manca una comunicazione uniforme prima e dopo ogni fase. |
| Alternative del catalogo | Completato | Tutte le pagine sono analizzate internamente; la chat mostra titoli raggruppati per ruolo scientifico. |
| Domande di raffinamento | Completato | Il workflow usa un solo blocco iniziale di massimo tre domande; richiede coordinate solo per luoghi ambigui. |
| Preventivo record/dimensione | Parziale | EPOS usa il preflight dimensionale quando disponibile; manca una strategia uniforme e una stima preventiva FDSN. |
| Pre-analisi e valutazione preliminare | Da fare | Non esiste ancora una fase standard per struttura, completezza, valori mancanti e anomalie evidenti. |
| Modalità demo | Da fare | Non esiste ancora un comando o stato dedicato alla demo. |
| Posizionamento esplicito researcher-in-the-loop | Completato | Consigli e motivazioni sono non vincolanti; descrizione ed esecuzione attendono la scelta del ricercatore salvo richiesta esplicita di selezione automatica. |
| Verifica reale su più provider | Da fare | La portabilità è implementata, ma va provata end-to-end con più modelli. |

## Funzionamento attuale

### Componenti

```text
Utente
  ↓
Pi — modello e orchestrazione
  ↓
estensione epos-tools — routing, sicurezza, provenance e workspace
  ├── MCP EPOS — catalogo, descrizione ed esecuzione dei servizi
  └── MCP FDSN — ricerca e dettagli degli eventi sismici
```

- `bin/epos-agent` avvia Pi con il prompt, tre skill EPOS progressive e l'estensione EPOS.
- `extensions/epos-tools/index.ts` registra i tool visibili al modello, gestisce il caricamento dinamico, i download FDSN, la provenance e la telemetria.
- `services/mcp-epos/src/server.mjs` traduce le API EPOS in contratti MCP compatti e tipizzati.
- `services/mcp-fdsnws-event` fornisce l'accesso specialistico ai datacenter FDSN.
- `workspace/` contiene dataset completi, script, immagini e altri output prodotti per l'utente.

### Selezione del modello

Il launcher non impone provider, modello o thinking level. Si possono usare la configurazione Pi oppure:

```bash
EPOS_PROVIDER=provider-id \
EPOS_MODEL=model-id \
EPOS_THINKING=medium \
/Users/alessandrocrocetta/epos-agent/bin/epos-agent
```

Il modello deve supportare il tool calling; un modello esclusivamente testuale non può invocare MCP.

### Ciclo di un turno

1. All'inizio sono attivi soltanto `read` ed `epos_load_tools`.
2. Pi espone soltanto nome, descrizione e percorso delle skill; il modello legge il corpo della skill pertinente quando serve.
3. Il modello interpreta la richiesta dell'utente.
4. Se servono altre capacità, il modello chiama autonomamente `epos_load_tools`.
5. Il router abilita uno o più gruppi: workflow, ricerca catalogo, ricerca software, descrizione, download, sismologia, analisi o workspace.
6. Pi usa il deferred loading nativo quando il modello lo supporta; altrimenti aggiorna normalmente la lista dei tool.
7. Il relativo server MCP viene avviato solo alla prima chiamata.
8. Il tool salva i dati completi nel workspace e restituisce al modello un risultato compatto.
9. Al turno utente successivo la lista dei tool viene riportata al set minimo.

### Ricerca e descrizione EPOS

`search_organizations` risolve un nome di provider in ID EPOS con filtro, deduplicazione, ranking locale e paginazione massima di cinque candidati. `search_resources` conserva il dominio durante il flattening dell'albero, deduplica per ID, applica localmente `scienceDomains` e ordina per pertinenza lessicale. L'estensione percorre automaticamente tutte le pagine di `search_resources` e `search_software`; l'agente mostra soltanto i titoli rilevanti raggruppati per ruolo scientifico.

Le istruzioni sono separate in `epos-search`, `epos-service-access` ed `epos-fdsn-earthquakes`. Pi mantiene nel prompt iniziale soltanto le loro descrizioni e carica il corpo pertinente su richiesta del modello.

Dopo la selezione, `describe_resource`, `describe_software` e `describe_service` caricano soltanto i dettagli dell'elemento scelto. I parametri del servizio vengono normalizzati e la richiesta ridondante `linkedentities` non viene eseguita.

### Download EPOS

`execute_service`:

1. recupera e valida i parametri dichiarati dal servizio;
2. esegue un preflight dimensionale quando disponibile;
3. applica il budget residuo del limite cumulativo di 1 GiB dello studio;
4. trasmette l'intera risposta direttamente nella directory `data/` del bundle;
5. genera un nome `epos-<resource>-<timestamp>.<estensione>` se non viene indicato;
6. restituisce in chat soltanto stato, dimensione, formato, percorso, breve anteprima e provenance.

L'anteprima può essere abbreviata. Una risposta HTTP scaricata integralmente viene distinta da un dataset scientificamente completo; quando quest'ultimo non è verificabile viene dichiarato esplicitamente.

### Download FDSN

Per `fdsn_query_earthquakes`:

- un `limit` esplicito viene rispettato;
- senza `limit`, il wrapper divide adattivamente l'intervallo temporale finché ogni partizione resta sotto il tetto del provider;
- gli eventi sono deduplicati per datacenter e `EventID` e gli estremi più vecchio/più recente sono verificati;
- tutti gli eventi vengono scritti in `fdsn-events-<datacenter>-<timestamp>.jsonl`;
- la chat riceve il conteggio totale e al massimo cinque eventi di esempio;
- un errore dopo una o più pagine produce un file `.partial.jsonl` e `complete: false`.

Gli identificatori degli eventi sono trattati come valori opachi specifici del provider e vengono copiati senza modificarli.

### File e dati locali

L'installazione predefinita usa `/Users/alessandrocrocetta/epos-agent/`:

```text
/Users/alessandrocrocetta/epos-agent/
├── cache/xdg/             cache tecnica di Pi e delle librerie
├── sessions/              cronologia delle sessioni Pi
├── logs/provenance/       provenance delle operazioni
├── logs/token-usage.jsonl metriche di utilizzo
├── workspace/             bundle autocontenuti degli studi e output precedenti
├── config/pi-agent/       configurazione Pi
└── services/              server MCP installati
```

I nuovi studi vengono salvati in `workspace/<studio>-<timestamp>/`; `/workspace` mostra bundle attivo e artefatti recenti. I file precedenti nella radice della workspace non vengono spostati. Non esiste ancora una cache persistente personalizzata delle risposte EPOS. I tool attivi sono mantenuti in memoria e vengono resettati a ogni nuovo turno.

## Risultati di verifica disponibili

- Riduzione stimata del contesto iniziale: circa 69,9%, da 8.331 a 2.506 caratteri tra prompt e schemi EPOS.
- Benchmark offline rappresentativo aggregato: circa 92,5% di riduzione.
- Smoke test MCP EPOS: sette tool, schemi di input/output e `structuredContent` validi, compreso `search_organizations`.
- Discovery Pi verificata con tre skill e nessuna diagnostica; il blocco iniziale delle skill misura 1.497 caratteri e non contiene i corpi completi.
- Search live verificata con `earthquake catalogue`: otto risultati, cinque schede e cataloghi ESHM20 nelle prime posizioni.
- Risoluzione provider live verificata con INGV: organizzazione ufficiale al primo posto e successiva ricerca limitata al relativo ID.
- Download EPOS verificato byte per byte con risposta completa nel workspace.
- Paginazione FDSN verificata temporaneamente con 1.003 eventi su due pagine.
- Limite FDSN esplicito verificato con sette eventi su una sola chiamata.
- Errore intermedio verificato con 1.000 eventi conservati in `.partial.jsonl`.
- Router, reset per turno, launcher senza provider predefinito e telemetria sono stati verificati.
- Stato conversazionale verificato con harness temporaneo per aggiornamento, ripristino, reset e conservazione dopo errore.
- Gli artefatti temporanei di test sono stati eliminati; non sono stati aggiunti test, fixture o snapshot al repository.

Le percentuali sui token sono stime offline basate sulla dimensione del contesto, non misure definitive di fatturazione su provider reali. La suite FDSN completa basata su Docker non è stata eseguita perché l'accesso al daemon Docker non è stato autorizzato; sono stati eseguiti parsing Python e smoke test MCP reale.

## Lavoro ancora da fare

### 2. Workflow guidati — completato

Il flusso generale è: scheda del contesto → domanda scientifica → servizi e piano → conferma unica e download → visualizzazione → script e notebook. Lo stato v2 registra fase, piano, budget e artefatti. La raccolta dei dettagli mancanti avviene in un solo blocco iniziale; località e coordinate vengono ricavate dai metadata disponibili quando non sono ambigue.

### 3. Integrazione della skill `epos-api` nell'MCP

Il file originale `SKILL.md` e la specifica OpenAPI sono stati ricevuti. La parte di search è stata adattata al progetto mantenendo un solo server MCP EPOS e contratti utilizzabili da qualunque client o modello con tool calling; non è stato introdotto un secondo MCP specifico per LM Studio.

Attività da implementare:

1. **Completato:** aggiunto `definitions/api-spec.json` come contratto autorevole.
2. **Parziale:** `search_resources` è stato verificato e adattato; restano da allineare completamente `describe_resource`, `describe_service` ed `execute_service`.
3. **Completato:** aggiunto un tool compatto per `GET /resources/organizations`, con filtro e ranking locale.
4. Supportare `/resources/organizations/full` soltanto su richiesta esplicita, perché può restituire l'intera collezione e molti metadata.
5. Salvare per ogni risposta scaricata un file metadata adiacente con URL sorgente, stato HTTP, content type, header rilevanti e timestamp.
6. Aggiungere un'ispezione deterministica dei file salvati per riconoscere GeoJSON, CoverageJSON, CSV, JSON, XML/OGC, testo e dati binari.
7. Aggiungere una visualizzazione deterministica per mappe GeoJSON, tabelle CSV, CoverageJSON e strutture XML/OGC, conservando output e script nel workspace.
8. Introdurre un fetch controllato degli URL dei provider ottenuti dai metadata EPOS. Deve includere protezioni contro URL arbitrari, accessi locali e richieste non autorizzate.
9. Implementare il workflow OGC: recuperare prima `GetCapabilities`, quindi usare soltanto layer, feature type, coverage, CRS, estensioni spaziali e dimensioni temporali dichiarati dal documento.
10. Conservare l'attuale comportamento token-efficient: nuovi tool caricati tramite router, output compatti in chat e payload completi nel workspace.
11. Mantenere la portabilità MCP standard. Pi resta il launcher principale, ma il server non deve dipendere da Pi, OpenAI o LM Studio.
12. **Completato:** la skill monolitica è stata divisa in `epos-search`, `epos-service-access` ed `epos-fdsn-earthquakes`, caricate progressivamente senza duplicare il system prompt.

La parte search, organizzazioni e progressive skill è disponibile. L'attività resta parziale per metadata adiacenti, fetch controllato, inspect, visualize, OGC e allineamento completo degli altri contratti MCP.

### 4. Bundle riproducibili — completato

Ogni nuovo studio crea una directory autocontenuta:

```text
workspace/<studio>-<timestamp>/
├── data/
├── figures/
├── provenance.json
├── parameters.json
├── analysis.py
├── <studio>.ipynb
├── manifest.json
└── README.md
```

Il notebook importa `analysis.py`; `/workspace` mostra il bundle attivo e i file recenti.

### 5. Plot scientifici deterministici — completato nella skill

La skill seleziona grafici da formato, campi, geometrie e domanda scientifica senza centri, layer o località hardcoded. Sono coperti i casi comuni:

- mappa degli epicentri;
- serie temporale degli eventi;
- istogramma delle magnitudo;
- distribuzione spaziale GNSS;
- grafici vulcanologici;
- sovrapposizione su layer geografici.

Ogni grafico viene salvato nel bundle insieme a script, parametri e riferimenti al dataset sorgente.

### 6. Modalità demo

Introdurre una modalità che:

- risponda in modo breve;
- mostri chiaramente ogni passaggio;
- chieda conferma prima delle operazioni importanti;
- eviti di eseguire troppe azioni contemporaneamente;
- evidenzi il valore su discovery, riproducibilità e riduzione del lavoro ripetitivo.

Preparare almeno uno scenario stabile sui terremoti e successivamente il caso Etna con download, layer cartografico, script e grafico.

### 7. Researcher-in-the-loop — completato

Rendere sistematico il messaggio che l'agente:

- recupera e organizza dati e metadata;
- prepara codice iniziale;
- non certifica automaticamente la qualità scientifica del dataset;
- non sostituisce interpretazione, validazione e decisioni del ricercatore.

### 8. Template compatti di risposta — completato nelle istruzioni

Definire risposte coerenti per ricerca, selezione, pre-download, download completato, dataset parziale e grafico generato. Ogni risposta dovrebbe mostrare soltanto risultato, parametri essenziali, stato di completezza e prossimo passo.

### 9. Verifica finale su ambienti reali

- Eseguire la suite FDSN completa con Docker.
- Provare il progetto con almeno due provider differenti.
- Eseguire scenari reali contro EPOS e più datacenter FDSN.
- Confrontare `logs/token-usage.jsonl` prima e dopo su conversazioni equivalenti.
- Verificare tempi, costi, cache e comportamento su sessioni lunghe.

## Ordine di implementazione consigliato

1. Completare fetch controllato, ispezione e workflow OGC dell'integrazione `epos-api`.
2. Rafforzare la pre-analisi standardizzata per formati non tabellari.
3. Introdurre la modalità demo senza regole specifiche per una località.
4. Eseguire test live multi-provider e misurazione token reale quando richiesto.

Questa sequenza permette di riutilizzare quanto già costruito senza aumentare nuovamente il contesto e senza introdurre tool isolati privi di uno stato operativo comune.
