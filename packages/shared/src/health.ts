export type ServiceState = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  services: {
    postgres: ServiceState;
    redis: ServiceState;
    moderation: ServiceState;
  };
  time: string;
}
