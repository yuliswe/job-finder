export type JobStatus =
  | 'Evaluada'
  | 'Aplicada'
  | 'Entrevista'
  | 'Rechazada'
  | 'Descartada'
  | 'No aplicar';

export type Tab =
  | 'TODAS'
  | 'EVALUADA'
  | 'APLICADO'
  | 'ENTREVISTA'
  | 'TOP'
  | 'NO APLICAR';

export type Job = {
  score: number;
  company: string;
  title: string;
  status: JobStatus;
  salary: string | null;
};
