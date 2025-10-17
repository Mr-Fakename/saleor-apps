import { Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { DownloadToken } from "@/modules/download-tokens/domain/download-token";

export const DownloadTokenRepoErrors = {
  NotFoundError: BaseError.subclass("NotFoundError", {
    props: {
      _brand: "DownloadTokenRepo.NotFoundError" as const,
    },
  }),
  SaveError: BaseError.subclass("SaveError", {
    props: {
      _brand: "DownloadTokenRepo.SaveError" as const,
    },
  }),
  UpdateError: BaseError.subclass("UpdateError", {
    props: {
      _brand: "DownloadTokenRepo.UpdateError" as const,
    },
  }),
  DeleteError: BaseError.subclass("DeleteError", {
    props: {
      _brand: "DownloadTokenRepo.DeleteError" as const,
    },
  }),
  FetchError: BaseError.subclass("FetchError", {
    props: {
      _brand: "DownloadTokenRepo.FetchError" as const,
    },
  }),
};

export type DownloadTokenRepoError =
  | InstanceType<typeof DownloadTokenRepoErrors.NotFoundError>
  | InstanceType<typeof DownloadTokenRepoErrors.SaveError>
  | InstanceType<typeof DownloadTokenRepoErrors.UpdateError>
  | InstanceType<typeof DownloadTokenRepoErrors.DeleteError>
  | InstanceType<typeof DownloadTokenRepoErrors.FetchError>;

export interface DownloadTokenRepo {
  save(token: DownloadToken): Promise<Result<DownloadToken, DownloadTokenRepoError>>;
  getByToken(token: string): Promise<Result<DownloadToken, DownloadTokenRepoError>>;
  incrementDownloadCount(token: string): Promise<Result<DownloadToken, DownloadTokenRepoError>>;
  delete(token: string): Promise<Result<void, DownloadTokenRepoError>>;
  listByOrder(orderId: string): Promise<Result<DownloadToken[], DownloadTokenRepoError>>;
}
