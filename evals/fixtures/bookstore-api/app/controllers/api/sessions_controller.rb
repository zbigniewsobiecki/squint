module Api
  class SessionsController < BaseController
    skip_before_action :authenticate!, only: [:create]

    def create
      user = User.authenticate(session_params[:email], session_params[:password])

      if user
        token = generate_auth_token(user)
        render_success({ token: token, user: { id: user.id, email: user.email, name: user.name } })
      else
        render_error('Invalid email or password', status: :unauthorized)
      end
    end

    def destroy
      current_user.update!(auth_token: nil)
      head :no_content
    end

    private

    def session_params
      params.require(:session).permit(:email, :password)
    end

    def generate_auth_token(user)
      token = SecureRandom.hex(32)
      user.update!(auth_token: token)
      token
    end
  end
end
