import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InvitationAcceptController } from './invitation-accept.controller.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [AuthModule],
  controllers: [InvitationsController, InvitationAcceptController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
