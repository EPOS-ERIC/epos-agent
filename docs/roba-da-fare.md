## 15. Cosa non è ancora implementato

Il progetto non deve essere descritto come completo oltre ciò che esiste. In
particolare, restano fuori dalla fase corrente:
- template deterministici per grafici, mappe e notebook;
- verifica end-to-end su più provider/modelli.

La dimensione della risposta grezza ricevuta dal server EPOS resta fuori scope:
l'MCP la deve comunque leggere per poter fare flattening e ranking; l'obiettivo
attuato è non trasferirla tutta al modello.
## 16. Come orientarsi durante la manutenzione


Un'estensione nuova dovrebbe seguire questa regola pratica:
5. tenere le risposte inviate al modello piccole e salvare i dati completi nel
   workspace;
6. verificare prima il contratto MCP e poi una query reale rappresentativa.

Questa disciplina mantiene separati i tre livelli fondamentali: *policy* nelle
skill, *orchestrazione* nell'estensione e *fatti/azioni tecniche* nei server MCP.



- far generare dei pdf modificabili
- aggiustare l'installer windows
Considera il periodo fino al 28 febbraio 2017 e come estrazione la localizzazione del terremoto di Amatrice del 24 agosto 2016 e un raggio di 50 km, senza limite di magnitudo. /