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
15. Mantenere la conferma oltre 50 MB e il limite assoluto di 1 GB.
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
27. Presentare tutte le alternative disponibili in modo incrementale: prima le più rilevanti, poi le successive soltanto su richiesta, dichiarando sempre che esistono altre opzioni.
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
| Paginazione compatta del catalogo | Completato | Cinque schede per pagina di default; non limita i dati scientifici. |
| Download EPOS completo nel workspace | Completato | La chat riceve percorso, dimensione, formato, anteprima e provenance. |
| Download FDSN multipagina | Completato | Senza limite esplicito vengono percorse tutte le pagine. |
| File FDSN parziali in caso di errore | Completato | Il suffisso `.partial.jsonl` indica un dataset incompleto. |
| Protezioni 50 MB e 1 GB | Completato | Conferma esplicita oltre 50 MB, rifiuto oltre 1 GB. |
| Telemetria provider-neutral | Completato | Token, cache e costo sono registrati senza prompt o dati scientifici. |
| Workflow guidati per utenti non esperti | Parziale | La ricerca ora guida scelta e raffinamento; restano da strutturare download, pre-analisi e produzione degli output. |
| Stato conversazionale sintetico | Completato | Lo stato operativo compatto è persistente per sessione e branch, aggiornato dai tool e reinserito nel prompt senza dati scientifici raw. |
| Bundle riproducibile per ogni download | Parziale | Dataset e provenance esistono, ma non sono ancora raccolti con script e README. |
| Generazione automatica di codice/notebook | Da fare | È possibile eseguire Python, ma il codice riproducibile non viene sempre generato. |
| Tool e skill specifici per i plot | Da fare | Sono disponibili Python e visualizzazione immagini, non template scientifici deterministici. |
| Integrazione della skill `epos-api` nell'MCP | Parziale | OpenAPI locale, ricerca organizzazioni e search token-efficient sono integrate; mancano metadata adiacenti, fetch controllato, inspect, visualize e workflow OGC. |
| Trasparenza delle operazioni | Parziale | Provenance e stato sono disponibili, ma manca una comunicazione uniforme prima e dopo ogni fase. |
| Opzioni incrementali | Completato | Il catalogo mostra tutti i risultati della pagina corrente, massimo cinque, dichiara quelli rimanenti e recupera altre pagine soltanto su richiesta. |
| Domande di raffinamento | Completato | Dopo la ricerca il modello pone da una a tre domande soltanto sui dettagli mancanti e propone i passi successivi. |
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
5. Il router abilita uno o più gruppi: ricerca catalogo, ricerca software, descrizione, download, sismologia, analisi o workspace.
6. Pi usa il deferred loading nativo quando il modello lo supporta; altrimenti aggiorna normalmente la lista dei tool.
7. Il relativo server MCP viene avviato solo alla prima chiamata.
8. Il tool salva i dati completi nel workspace e restituisce al modello un risultato compatto.
9. Al turno utente successivo la lista dei tool viene riportata al set minimo.

### Ricerca e descrizione EPOS

`search_organizations` risolve un nome di provider in ID EPOS con filtro, deduplicazione, ranking locale e paginazione massima di cinque candidati. `search_resources` conserva il dominio durante il flattening dell'albero, deduplica per ID, applica localmente `scienceDomains` e ordina per pertinenza lessicale prima della paginazione. `search_resources` e `search_software` presentano al massimo cinque schede per pagina; l'agente mostra tutte le schede ricevute e recupera la pagina seguente soltanto su richiesta.

Le istruzioni sono separate in `epos-search`, `epos-service-access` ed `epos-fdsn-earthquakes`. Pi mantiene nel prompt iniziale soltanto le loro descrizioni e carica il corpo pertinente su richiesta del modello.

Dopo la selezione, `describe_resource`, `describe_software` e `describe_service` caricano soltanto i dettagli dell'elemento scelto. I parametri del servizio vengono normalizzati e la richiesta ridondante `linkedentities` non viene eseguita.

### Download EPOS

`execute_service`:

1. recupera e valida i parametri dichiarati dal servizio;
2. esegue un preflight dimensionale quando disponibile;
3. richiede conferma oltre 50 MB e rifiuta risposte oltre 1 GB;
4. trasmette l'intera risposta direttamente in un file nel workspace;
5. genera un nome `epos-<resource>-<timestamp>.<estensione>` se non viene indicato;
6. restituisce in chat soltanto stato, dimensione, formato, percorso, breve anteprima e provenance.

L'anteprima può essere abbreviata; il file dichiarato completo non viene troncato.

### Download FDSN

Per `fdsn_query_earthquakes`:

- un `limit` esplicito viene rispettato;
- senza `limit`, il wrapper percorre automaticamente tutte le pagine;
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
├── workspace/             dataset e output completi
├── config/pi-agent/       configurazione Pi
└── services/              server MCP installati
```

Non esiste ancora una cache persistente personalizzata delle risposte EPOS. I tool attivi sono mantenuti in memoria e vengono resettati a ogni nuovo turno. La cronologia della conversazione rimane nelle sessioni Pi, mentre i grandi dataset vengono salvati nel workspace e non inseriti integralmente nella chat.

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

### 2. Workflow guidati

Implementare un flusso esplicito e riutilizzabile articolato in quattro fasi:

```text
ricerca e scelta dei dati
  → download con preventivo e conferma
  → pre-analisi e prima valutazione
  → codice riproducibile e/o visualizzazione
```

Il comportamento di ogni fase deve essere:

1. spiegare brevemente cosa verrà fatto e perché;
2. raccogliere con domande mirate soltanto le informazioni mancanti;
3. mostrare tutti i risultati della pagina corrente, fino a cinque, con il numero totale disponibile;
4. indicare che esistono altre opzioni e attendere la richiesta dell'utente prima di espanderle;
5. mostrare il prossimo passo possibile senza prendere decisioni scientifiche al posto del ricercatore;
6. conservare nello stato sintetico le scelte già confermate, evitando di richiederle nuovamente.

Le operazioni supportate dal workflow devono includere:

- trova dati;
- descrivi e seleziona il servizio;
- raccogli e valida i parametri mancanti;
- stima record, dimensione e formato, distinguendo valori certi e stimati;
- conferma il download quando necessario;
- scarica i dati;
- esegui una pre-analisi di struttura, completezza, valori mancanti e anomalie evidenti;
- mostra provenance;
- genera codice o notebook;
- crea un grafico preliminare.

Il primo workflow verticale consigliato è “terremoti in Italia/Mediterraneo → preventivo → dataset completo → pre-analisi → provenance → script Python e/o visualizzazione”.

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

### 4. Bundle riproducibili

Dopo ogni download creare una directory autocontenuta:

```text
workspace/earthquakes-<timestamp>/
├── data.jsonl
├── provenance.json
├── parameters.json
├── analysis.py
└── README.md
```

Il codice deve essere leggibile e revisionabile, e deve permettere di ripetere download e analisi.

### 5. Plot scientifici deterministici

Creare una skill e tool dedicati, senza dipendere dalla generazione libera di codice per i casi comuni:

- mappa degli epicentri;
- serie temporale degli eventi;
- istogramma delle magnitudo;
- distribuzione spaziale GNSS;
- grafici vulcanologici;
- sovrapposizione su layer geografici.

Ogni grafico deve salvare immagine, script, parametri e riferimenti al dataset sorgente.

### 6. Modalità demo

Introdurre una modalità che:

- risponda in modo breve;
- mostri chiaramente ogni passaggio;
- chieda conferma prima delle operazioni importanti;
- eviti di eseguire troppe azioni contemporaneamente;
- evidenzi il valore su discovery, riproducibilità e riduzione del lavoro ripetitivo.

Preparare almeno uno scenario stabile sui terremoti e successivamente il caso Etna con download, layer cartografico, script e grafico.

### 7. Researcher-in-the-loop

Rendere sistematico il messaggio che l'agente:

- recupera e organizza dati e metadata;
- prepara codice iniziale;
- non certifica automaticamente la qualità scientifica del dataset;
- non sostituisce interpretazione, validazione e decisioni del ricercatore.

### 8. Template compatti di risposta

Definire risposte coerenti per ricerca, selezione, pre-download, download completato, dataset parziale e grafico generato. Ogni risposta dovrebbe mostrare soltanto risultato, parametri essenziali, stato di completezza e prossimo passo.

### 9. Verifica finale su ambienti reali

- Eseguire la suite FDSN completa con Docker.
- Provare il progetto con almeno due provider differenti.
- Eseguire scenari reali contro EPOS e più datacenter FDSN.
- Confrontare `logs/token-usage.jsonl` prima e dopo su conversazioni equivalenti.
- Verificare tempi, costi, cache e comportamento su sessioni lunghe.

## Ordine di implementazione consigliato

1. Workflow guidato e trasparente per terremoti, comprese domande di raffinamento e opzioni incrementali.
2. Integrazione della skill `epos-api` nel server MCP esistente.
3. Preventivo dati e pre-analisi standardizzata.
4. Bundle riproducibile automatico.
5. Skill e tool per plot deterministici.
6. Modalità demo e caso Etna.
7. Test live multi-provider e misurazione token reale.

Questa sequenza permette di riutilizzare quanto già costruito senza aumentare nuovamente il contesto e senza introdurre tool isolati privi di uno stato operativo comune.
