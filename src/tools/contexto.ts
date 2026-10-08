// Contexto por turno: el maestro (CSV + bitácora) contra el que operan las herramientas.
import { AsyncLocalStorage } from "node:async_hooks";
import { Maestro, type Operacion } from "../domain/maestro.js";
import { maestroBase } from "../data/repo.js";

const als = new AsyncLocalStorage<Maestro>();
let global: Maestro | null = null; // para demo.ts y pruebas (fuera de un turno HTTP)

export const nuevoMaestro = (ops: Operacion[] = []) => new Maestro(maestroBase(), ops);
export const maestroActual = () => als.getStore() ?? (global ??= nuevoMaestro());
export const conMaestro = <T>(m: Maestro, fn: () => Promise<T>) => als.run(m, fn);
export const reiniciarMaestro = () => { global = null; };
